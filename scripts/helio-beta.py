#!/usr/bin/env python3
"""Read-only preparation for beta database maintenance.

No database mutations are exposed until database RBAC and process isolation
have been provisioned and independently verified.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, subprocess, sys
from pathlib import Path

DATABASE = "elo_beta"
MAX_OPERATIONS = 50
MAX_PLAN_BYTES = 2 * 1024 * 1024
COLLECTION = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$")
OID = re.compile(r"^[a-fA-F0-9]{24}$")
DANGEROUS = {"dropDatabase", "dropCollection", "dropIndex", "renameCollectionSameDB",
             "createUser", "dropUser", "updateUser", "grantRole", "revokeRole", "createRole", "dropRole"}
# The owner explicitly granted the search-index and validation actions below.
# These are accepted only on elo_beta; this does not enable maintenance writes.
DATA_ACTIONS = {"find", "insert", "update", "remove", "createCollection", "createIndex",
                "listCollections", "listIndexes", "collStats", "dbStats", "dbHash", "changeStream",
                "createSearchIndexes", "listSearchIndexes", "updateSearchIndex", "dropSearchIndex",
                "bypassDocumentValidation", "validate"}

class Blocked(Exception): pass

def evaluate_privileges(auth):
    """Fail closed on missing evidence or grants outside beta and destructive admin grants."""
    if not isinstance(auth, dict) or not auth.get("authenticatedUsers"):
        return False, "No authenticated MongoDB identity was reported."
    privileges = auth.get("authenticatedUserPrivileges")
    if not isinstance(privileges, list) or not privileges:
        return False, "MongoDB did not disclose effective privileges."
    beta_actions = set()
    for privilege in privileges:
        if not isinstance(privilege, dict) or not isinstance(privilege.get("resource"), dict) or not isinstance(privilege.get("actions"), list):
            return False, "MongoDB returned an unrecognized privilege."
        resource = privilege["resource"]
        actions = set(privilege["actions"])
        if actions & DANGEROUS:
            return False, "The identity has destructive or administrative privileges."
        if resource.get("anyResource") is True:
            return False, "The identity has an unrestricted resource grant."
        if set(resource) != {"db", "collection"} or resource.get("db") != DATABASE:
            return False, "The identity has privileges outside elo_beta or an unrecognized resource."
        allowed = DATA_ACTIONS | {"killCursors"}
        if not actions <= allowed:
            return False, "The identity has privileges that have not been explicitly allowed."
        if resource.get("collection") == "": beta_actions |= actions
    if not {"find", "insert", "update", "remove"}.issubset(beta_actions):
        return False, "Beta-wide find, insert, update and remove privileges were not established."
    return True, "Effective data privileges appear limited to elo_beta."

def valid_id(value):
    if isinstance(value, str): return bool(value) and len(value) <= 200
    if isinstance(value, int) and not isinstance(value, bool): return -(2**63) <= value < 2**63
    if not isinstance(value, dict) or len(value) != 1: return False
    if set(value) == {"$oid"}: return isinstance(value["$oid"], str) and bool(OID.fullmatch(value["$oid"]))
    if set(value) not in ({"$numberInt"}, {"$numberLong"}): return False
    key = next(iter(value)); raw = value[key]
    if not isinstance(raw, str) or not re.fullmatch(r"-?(0|[1-9][0-9]*)", raw): return False
    number = int(raw); bits = 32 if key == "$numberInt" else 64
    return -(2 ** (bits - 1)) <= number < 2 ** (bits - 1)

def identity_key(value):
    if isinstance(value, dict):
        if "$oid" in value: return "oid:" + value["$oid"].lower()
        return "number:" + str(int(next(iter(value.values()))))
    if isinstance(value, int): return "number:" + str(value)
    return "string:" + value

def valid_path(path):
    if not isinstance(path, str) or not path or len(path) > 250 or "\x00" in path: return False
    parts = path.split(".")
    return bool(parts) and parts[0] != "_id" and all(part and not part.startswith("$") for part in parts)

def validate_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"database", "purpose", "operations"}:
        raise ValueError("Plan must contain only database, purpose and operations.")
    if plan["database"] != DATABASE: raise ValueError("Only elo_beta is allowed.")
    purpose = plan["purpose"]
    if not isinstance(purpose, str) or not purpose.strip() or len(purpose) > 500:
        raise ValueError("A concise test purpose is required.")
    ops = plan["operations"]
    if not isinstance(ops, list) or not 1 <= len(ops) <= MAX_OPERATIONS:
        raise ValueError(f"Specify 1-{MAX_OPERATIONS} targeted operations.")
    targets, summary = set(), []
    for op in ops:
        if not isinstance(op, dict): raise ValueError("Operation must be an object.")
        action = op.get("action")
        allowed = {"collection", "id", "action", "reason", "before"}
        if action == "update": allowed |= {"set", "unset"}
        elif action != "delete": raise ValueError("Only targeted update or delete is supported.")
        if set(op) - allowed or not {"collection", "id", "action", "reason", "before"} <= set(op):
            raise ValueError("Operation has missing or unsupported fields.")
        name, identity, before = op["collection"], op["id"], op["before"]
        if not isinstance(name, str) or not COLLECTION.fullmatch(name) or name.startswith("system."):
            raise ValueError("Invalid or system collection.")
        if not valid_id(identity) or not isinstance(before, dict) or not valid_id(before.get("_id")) or identity_key(before.get("_id")) != identity_key(identity):
            raise ValueError("Each exact ID must match its full before document.")
        reason = op["reason"]
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
            raise ValueError("Each operation requires a concise reason.")
        key = (name, identity_key(identity))
        if key in targets: raise ValueError("A document may appear only once per plan.")
        targets.add(key)
        paths = []
        if action == "update":
            set_fields, unset_fields = op.get("set", {}), op.get("unset", [])
            if not isinstance(set_fields, dict) or not isinstance(unset_fields, list):
                raise ValueError("Update set must be an object and unset must be a list.")
            paths = list(set_fields) + unset_fields
            if not paths or any(not valid_path(x) for x in paths):
                raise ValueError("Update requires safe field paths and cannot change _id.")
            if any(a == b or a.startswith(b + ".") or b.startswith(a + ".") for i, a in enumerate(paths) for b in paths[i+1:]):
                raise ValueError("Overlapping update paths are not allowed.")
        canonical = json.dumps(before, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        summary.append({"collection": name, "id": identity, "action": action, "reason": reason, "paths": paths,
                        "before_sha256": hashlib.sha256(canonical).hexdigest()})
    return summary

def connect_beta(env_path):
    from dotenv import dotenv_values
    from pymongo import MongoClient
    import certifi
    path = Path(env_path)
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise Blocked("The beta environment must be an owner-only regular file.")
    uri = dotenv_values(path).get("MONGO_DB_URL")
    if not uri: raise Blocked("The beta MongoDB connection URL is missing.")
    if "<db_username>" in uri or "<db_password>" in uri:
        raise Blocked("Replace the username and password placeholders in the beta MongoDB environment.")
    return MongoClient(uri, tls=True, tlsCAFile=certifi.where(), serverSelectionTimeoutMS=7000, connectTimeoutMS=7000)

def privilege_probe(env_path):
    client=connect_beta(env_path)
    try:
        info=client[DATABASE].command({"connectionStatus":1,"showPrivileges":True})
        return evaluate_privileges(info.get("authInfo"))
    finally: client.close()

def inspect_document(env_path, collection, raw_id):
    from bson import json_util
    if not COLLECTION.fullmatch(collection) or collection.startswith("system."):
        raise ValueError("Invalid or system collection.")
    identity=json.loads(raw_id)
    if not valid_id(identity):raise ValueError("Expected an exact string, integer or Extended JSON ObjectId.")
    decoded=json_util.loads(json.dumps(identity))
    client=connect_beta(env_path)
    try:
        info=client[DATABASE].command({"connectionStatus":1,"showPrivileges":True})
        safe,detail=evaluate_privileges(info.get("authInfo"))
        if not safe:raise Blocked("Read refused: "+detail)
        doc=client[DATABASE][collection].find_one({"_id":decoded})
        return None if doc is None else json.loads(json_util.dumps(doc,json_options=json_util.CANONICAL_JSON_OPTIONS))
    finally: client.close()

def process_exposure(home=None, project=None, wsl_exe=None):
    home=Path.home() if home is None else Path(home)
    project=Path(os.environ.get("HELIO_PROJECT",home/"PythonProjects/elo-bot")) if project is None else Path(project)
    wsl_exe=Path("/mnt/c/Windows/System32/wsl.exe") if wsl_exe is None else Path(wsl_exe)
    return {
        "project_env_readable":os.access(project/".env",os.R_OK),
        "ssh_directory_accessible":os.access(home/".ssh",os.R_OK|os.X_OK),
        "windows_wsl_executable_accessible":os.access(wsl_exe,os.X_OK),
        "host_herdr_socket_accessible":os.access(home/".config/herdr/sessions/elobot/herdr.sock",os.W_OK),
    }

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest="command",required=True)
    status=sub.add_parser("status"); status.add_argument("--probe",action="store_true",help="read effective MongoDB role metadata")
    plan=sub.add_parser("plan"); plan.add_argument("file",type=Path)
    inspect=sub.add_parser("inspect"); inspect.add_argument("collection"); inspect.add_argument("id_json",help="exact ID encoded as JSON")
    apply_parser=sub.add_parser("apply"); apply_parser.add_argument("file",nargs="?",type=Path)
    run_parser=sub.add_parser("run"); run_parser.add_argument("--check",action="store_true")
    commands=sub.add_parser("commands"); commands.add_argument("action",choices=("list","mention","delete","paste")); commands.add_argument("target",nargs="?",help="mention: the command, e.g. \"match base submit\"; paste: the text"); commands.add_argument("--channel",help="mention: channel or thread ID (default: the Test thread)")
    import runpy
    qa_module=runpy.run_path(str(Path(__file__).with_name("helio_beta_qa.py"))); qa_module["add_parser"](sub)
    args=parser.parse_args()
    if args.command == "status":
        exposure=process_exposure()
        try:
            service = subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", "helio-beta-maintenance.service"],
                                     timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        except (OSError, subprocess.SubprocessError): service = False
        import runpy
        client=runpy.run_path(str(Path(__file__).with_name("helio_beta_client.py")))
        broker_ready=client["healthy"]()
        if broker_ready:
            exposure["session_herdr_socket_accessible"]=exposure.pop("host_herdr_socket_accessible")
        unsafe=any(v for k,v in exposure.items() if k!="session_herdr_socket_accessible")
        result={"database":DATABASE,"writes_enabled":bool(broker_ready and not unsafe),
                "process_isolation":"unsafe: broader access paths present" if unsafe else "no exposed paths detected; verify installed runtime separately",
                "observed_exposure":exposure,
                "backup_service":"authorized broker connected" if broker_ready else ("running; agent integration not verified" if service else "not running")}

        if args.probe:
            try:
                safe,detail=privilege_probe(os.environ.get("HELIO_BETA_MONGO_ENV",str(Path.home()/".dori/elobot/beta-mongo.env")))
                result.update({"credential_beta_only":safe,"credential_detail":detail})
                if not safe: result["writes_enabled"]=False
            except Blocked as error:
                result.update({"credential_beta_only":False,"credential_detail":str(error),"writes_enabled":False})
            except Exception as error:
                result.update({"credential_beta_only":False,"credential_detail":f"Privilege check failed ({type(error).__name__}).","writes_enabled":False})
        print(json.dumps(result,indent=2));return 0 if result["writes_enabled"] else 1
    if args.command == "inspect":
        try:
            doc=inspect_document(os.environ.get("HELIO_BETA_MONGO_ENV",str(Path.home()/".dori/elobot/beta-mongo.env")),args.collection,args.id_json)
            print(json.dumps({"database":DATABASE,"collection":args.collection,"found":doc is not None,"document":doc},ensure_ascii=False))
            return 0
        except Blocked: raise
        except Exception as error: raise Blocked(f"Read failed ({type(error).__name__}).") from None
    if args.command == "qa": return qa_module["main"](args)
    if args.command == "commands":
        mentions=runpy.run_path(str(Path(__file__).with_name("helio_beta_commands.py")))
        try: return mentions["main"](args.action,args.target,args.channel)
        except (mentions["CommandsError"],OSError) as error: raise Blocked(str(error)) from None
    if args.command == "run":
        import runpy
        runner=runpy.run_path(str(Path(__file__).with_name("helio_beta_run.py")))
        try: return runner["start"](Path.home(),args.check)
        except runner["RunError"] as error: raise Blocked(str(error)) from None
    if args.command == "apply":
        if args.file is None: raise Blocked("Beta writes are disabled without a plan submitted from the isolated runtime.")
        import runpy
        client=runpy.run_path(str(Path(__file__).with_name("helio_beta_client.py")))
        try: return client["apply"](args.file,validate_plan)
        except client["ClientError"] as error: raise Blocked(str(error)) from None
    if args.file.stat().st_size > MAX_PLAN_BYTES:raise ValueError("Plan is too large.")
    with args.file.open(encoding="utf-8") as f: data=json.load(f)
    summary=validate_plan(data)
    print(json.dumps({"database":DATABASE,"purpose":data["purpose"],"status":"validated_offline_only","writes_enabled":False,
                      "backup_created":False,"operations":summary},indent=2));return 0

if __name__ == "__main__":
    try:sys.exit(main())
    except (OSError,ValueError,Blocked) as e:print(f"BETA_BLOCKED {e}",file=sys.stderr);sys.exit(1)
