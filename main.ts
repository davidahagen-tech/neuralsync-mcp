export default {
  fetch(): Response {
    return new Response("🧠 NeuralSynch MCP Server is LIVE!", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};
