// Runs only for a request that matches no static file.
export default {
  async fetch(request, env) {
    return new Response(
      JSON.stringify({ from: "the script", path: new URL(request.url).pathname, env_keys: Object.keys(env) }) + "\n",
      { status: 404, headers: { "content-type": "application/json" } },
    );
  },
};
