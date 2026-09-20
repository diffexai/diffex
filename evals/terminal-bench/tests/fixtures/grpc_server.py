"""Known-correct service for the pinned verifier, with process identity evidence."""

from concurrent import futures
import json
import os
from pathlib import Path
import threading

import grpc
import kv_store_pb2
import kv_store_pb2_grpc


class Server(kv_store_pb2_grpc.KVStoreServicer):
    def __init__(self):
        self.values = {}
        self.lock = threading.Lock()

    def GetVal(self, request, context):
        with self.lock:
            return kv_store_pb2.GetValResponse(val=self.values.get(request.key, 0))

    def SetVal(self, request, context):
        with self.lock:
            self.values[request.key] = request.value
            return kv_store_pb2.SetValResponse(val=request.value)


server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
kv_store_pb2_grpc.add_KVStoreServicer_to_server(Server(), server)
assert server.add_insecure_port("127.0.0.1:5328") == 5328
server.start()
stat = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()
Path(os.environ["DIFFEX_TB_RUN_DIR"], "service.json").write_text(json.dumps({
    "pid": os.getpid(), "start": stat[19], "port": 5328, "protocol": "grpc",
}))
server.wait_for_termination()
