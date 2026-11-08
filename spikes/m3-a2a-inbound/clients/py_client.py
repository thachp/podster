"""The project's Python SDK client against `npm run dev`. Unpatched: auth is an httpx client with a default header."""
import asyncio, os, sys, uuid

import httpx
from a2a.client import ClientConfig, create_client
from a2a.types import GetTaskRequest, ListTasksRequest, Message, Part, Role, SendMessageRequest, TaskState

BASE = os.environ.get("SUT", "http://localhost:8787")
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'ok  ' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")


def text(task_id, value):
    m = Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER, parts=[Part(text=value)])
    if task_id:
        m.task_id = task_id
    return SendMessageRequest(message=m)


async def client_for(token):
    http = httpx.AsyncClient(headers={"authorization": f"Bearer {token}"})
    return await create_client(BASE, client_config=ClientConfig(httpx_client=http)), http


async def main():
    async with httpx.AsyncClient() as h:
        await h.post(f"{BASE}/spike/reset")
    client, http = await client_for("tok-worker")

    task = await client.get_task(GetTaskRequest(id="tsk_accepted"))
    check("GetTask", task.id == "tsk_accepted" and task.status.state == TaskState.TASK_STATE_WORKING, TaskState.Name(task.status.state))

    events = [e async for e in client.send_message(text("tsk_accepted", "From the Python SDK."))]
    last = events[-1].task.history[-1].parts[0].text if events and events[-1].HasField("task") else None
    check("SendMessage to an existing task (streaming off, so one response)", len(events) == 1 and last == "From the Python SDK.", f"{len(events)} event(s)")

    listed = await client.list_tasks(ListTasksRequest())
    ids = ",".join(t.id for t in listed.tasks)
    check("ListTasks scoped", ids == "tsk_accepted,tsk_done,tsk_offered", ids)

    for name, call, want in [
        ("hidden task refused", client.get_task(GetTaskRequest(id="tsk_hidden")), "TaskNotFound"),
        ("no taskId refused", anext(aiter(client.send_message(text(None, "new task?")))), "UnsupportedOperation"),
    ]:
        try:
            await call
            check(name, False)
        except Exception as e:  # noqa: BLE001
            check(name, want in type(e).__name__ or want.lower() in str(e).lower().replace(" ", ""), type(e).__name__)

    other, other_http = await client_for("tok-outsider")
    check("outsider sees nothing", len((await other.list_tasks(ListTasksRequest())).tasks) == 0)

    await http.aclose(); await other_http.aclose()
    failed = results.count(False)
    print(f"{len(results) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


asyncio.run(main())
