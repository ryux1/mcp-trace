import asyncio
import json
import socket

import uvicorn
from mcp.server.mcpserver import MCPServer

server = MCPServer("mcp-trace-python-test-server", log_level="ERROR")


@server.tool()
def echo(message: str) -> str:
    """Echo a synthetic compatibility-test message."""
    return f"through mcp-trace: {message}"


async def main() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]

    app = server.streamable_http_app(
        host="127.0.0.1",
        json_response=True,
        stateless_http=True,
    )
    uvicorn_server = uvicorn.Server(
        uvicorn.Config(app, log_level="error", lifespan="on")
    )
    serving = asyncio.create_task(uvicorn_server.serve(sockets=[listener]))

    while not uvicorn_server.started:
        if serving.done():
            await serving
            raise RuntimeError("Python MCP server stopped before becoming ready")
        await asyncio.sleep(0.01)

    print(json.dumps({"event": "ready", "port": port}), flush=True)
    await serving


if __name__ == "__main__":
    asyncio.run(main())
