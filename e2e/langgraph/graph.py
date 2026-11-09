"""One trivial graph for M3's outbound check against LangGraph's A2A server (decision 143). It reads the last message and
answers with a fixed line naming how long that message was, so the check can see the offer arrived, without echoing it."""

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph


def answer(state: MessagesState) -> dict:
    last = state["messages"][-1]
    text = last.content if isinstance(last.content, str) else str(last.content)
    turn = sum(1 for m in state["messages"] if m.type == "human")
    return {"messages": [AIMessage(content=f"LangGraph test graph: turn {turn}, received {len(text)} characters.")]}


builder = StateGraph(MessagesState)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
builder.add_edge("answer", END)
graph = builder.compile()
