import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";
import { checkGateKey, gateUnauthorizedMessage } from "../lib/gate.js";

export const config = {
  api: { bodyParser: true },
};

// 접근 게이트는 lib/gate.js가 담당한다(api/raw.js와 같은 코드를 쓴다).

/**
 * 이 요청이 도달한 주소(스킴+호스트)를 돌려준다.
 * drive_file의 download_link가 조각 다운로드 URL을 만들 때 기준 도메인으로 쓴다 —
 * 호출자가 실제로 쓴 주소를 그대로 쓰므로 배포 전용 URL·고정 별칭 어느 쪽이든 맞는다.
 */
function requestBaseUrl(req) {
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host;
  if (!host) return undefined;
  const proto = req.headers?.["x-forwarded-proto"] || (host.startsWith("localhost") ? "http" : "https");
  return `${String(proto).split(",")[0].trim()}://${String(host).split(",")[0].trim()}`;
}

export default async function handler(req, res) {
  const gate = checkGateKey(req);
  if (gate.blocked) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: gateUnauthorizedMessage("/api/mcp") },
      })
    );
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "POST만 지원합니다" }, id: null });
    return;
  }

  // 게이트키와 호출 주소를 서버 컨텍스트로 넘긴다 — download_link가 돌려주는 조각 URL에
  // 이번 호출에 쓰인 게이트키를 그대로 실어야 호출자가 바로 받을 수 있다.
  const server = buildServer({ gateKey: gate.key, baseUrl: requestBaseUrl(req) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
