import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main(endpoint: str) -> None:
    async with (
        streamable_http_client(endpoint) as (read_stream, write_stream),
        ClientSession(read_stream, write_stream) as session,
    ):
        initialized = await session.initialize()
        tools = await session.list_tools()
        result = await session.call_tool("echo", {"message": "hello"})

        text = [
            block.text
            for block in result.content
            if getattr(block, "type", None) == "text"
        ]
        print(
            json.dumps(
                {
                    "content": text,
                    "event": "result",
                    "isError": result.is_error,
                    "protocolVersion": initialized.protocol_version,
                    "tools": [tool.name for tool in tools.tools],
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: client.py <mcp-endpoint>")
    asyncio.run(main(sys.argv[1]))
