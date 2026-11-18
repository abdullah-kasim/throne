import { createServer } from "node:http";

export const PI_PROVIDER_STAND_IN_MARKER = "PI_PROVIDER_STAND_IN";

export const STAND_IN_FINAL_ANSWER = "stand-in finished the task";
export const STAND_IN_WRITTEN_FILE = "stand-in-edit.txt";
export const STAND_IN_WRITTEN_TEXT = "written by the pi provider stand-in";

const DEFAULT_MODELS = [
  { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
  { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
];

function answeredToolCallCount(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.filter((message) => message.role === "tool").length;
}

function userText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text ?? "").join("");
  }
  return "";
}

function firstUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.filter((message) => message.role === "user").map(userText).join("\n");
}

function plannedReply(body) {
  const asksForTools = firstUserText(body).includes("edit a file and run a command");
  const answered = answeredToolCallCount(body);
  if (asksForTools && answered === 0) {
    return {
      toolCalls: [{
        id: "stand-in-write",
        name: "write",
        arguments: JSON.stringify({ path: STAND_IN_WRITTEN_FILE, content: STAND_IN_WRITTEN_TEXT }),
      }],
    };
  }
  if (asksForTools && answered === 1) {
    return {
      toolCalls: [{
        id: "stand-in-bash",
        name: "bash",
        arguments: JSON.stringify({ command: `cat ${STAND_IN_WRITTEN_FILE}` }),
      }],
    };
  }
  return { text: `${STAND_IN_FINAL_ANSWER} (${PI_PROVIDER_STAND_IN_MARKER})` };
}

function chunk(model, delta, finishReason = null) {
  return {
    id: "stand-in-completion",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeStream(response, model, reply) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  send(chunk(model, { role: "assistant", content: "" }));
  if (reply.toolCalls !== undefined) {
    reply.toolCalls.forEach((call, index) => {
      send(chunk(model, {
        tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
      }));
    });
    send(chunk(model, {}, "tool_calls"));
  } else {
    send(chunk(model, { content: reply.text }));
    send(chunk(model, {}, "stop"));
  }
  send({ ...chunk(model, {}), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  response.write("data: [DONE]\n\n");
  response.end();
}

function writeWhole(response, model, reply) {
  const message = reply.toolCalls !== undefined
    ? {
        role: "assistant",
        content: null,
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      }
    : { role: "assistant", content: reply.text };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "stand-in-completion",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls !== undefined ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (part) => (text += part));
    request.on("end", () => {
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

export async function startPiProviderStandIn(options = {}) {
  const state = {
    models: options.models ?? DEFAULT_MODELS,
    modelListAvailable: options.modelListAvailable ?? true,
    requests: [],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stand-in");
    const route = url.pathname.replace(/^\/v1/, "");
    if (request.method === "GET" && route === "/models") {
      if (!state.modelListAvailable) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "model list unavailable" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: state.models }));
      return;
    }
    if (request.method === "POST" && route === "/chat/completions") {
      const body = await readBody(request);
      state.requests.push(body);
      const reply = options.plannedReply === undefined ? plannedReply(body) : await options.plannedReply(body);
      const model = body.model ?? "deepseek-flash";
      if (body.stream === true) writeStream(response, model, reply);
      else writeWhole(response, model, reply);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `${PI_PROVIDER_STAND_IN_MARKER} has no route ${url.pathname}` }));
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests: state.requests,
    setModels(models) {
      state.models = models;
    },
    setModelListAvailable(available) {
      state.modelListAvailable = available;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

export async function writeStandInAgentDirectory(agentDirectory, baseUrl, writeFile, mkdir) {
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(
    `${agentDirectory}/models.json`,
    `${JSON.stringify({ providers: { deepseek: { baseUrl } } }, null, 2)}\n`,
  );
}
