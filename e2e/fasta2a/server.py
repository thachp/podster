"""One trivial fasta2a agent for M3's outbound check (decision 143's backup independent server). It reports WORKING, waits
RUN_SECONDS, then COMPLETED with one text artifact naming its turn in the context and the length of what it was sent. It
never echoes the text it was sent. Run it with uvicorn on 127.0.0.1 only."""

import os
import uuid
from contextlib import asynccontextmanager

import anyio
from fasta2a import FastA2A, Worker
from fasta2a.broker import InMemoryBroker
from fasta2a.storage import InMemoryStorage

RUN_SECONDS = float(os.environ.get("RUN_SECONDS", "3"))


def text_of(message) -> str:
    return "".join(part.get("text", "") for part in message.get("parts", []))


class TrivialWorker(Worker[list]):
    async def run_task(self, params) -> None:
        task = await self.storage.load_task(params["id"])
        assert task is not None
        await self.storage.update_task(task["id"], state="working")
        context = await self.storage.load_context(task["context_id"]) or []
        context.append(params["message"])
        await self.storage.update_context(task["context_id"], context)
        await anyio.sleep(RUN_SECONDS)
        current = await self.storage.load_task(task["id"])
        if current is not None and current["status"]["state"] == "canceled":
            return
        turn = sum(1 for m in context if m.get("role") == "user")
        reply = f"fasta2a test agent: turn {turn}, received {len(text_of(params['message']))} characters."
        artifact = {"artifact_id": str(uuid.uuid4()), "name": "Result", "parts": [{"text": reply}]}
        await self.storage.update_task(task["id"], state="completed", new_artifacts=[artifact])

    async def cancel_task(self, params) -> None:
        await self.storage.update_task(params["id"], state="canceled")

    def build_message_history(self, history):
        return history

    def build_artifacts(self, result):
        return []


storage = InMemoryStorage()
broker = InMemoryBroker()
worker = TrivialWorker(broker=broker, storage=storage)


@asynccontextmanager
async def lifespan(app: FastA2A):
    async with app.task_manager:
        async with worker.run():
            yield


app = FastA2A(storage=storage, broker=broker, name="Podster fasta2a test agent", url="http://127.0.0.1", lifespan=lifespan)
