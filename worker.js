// Serves masonchambers.com and design.masonchambers.com from one set of static files.
// The design subdomain is the /design folder; shared files under /assets stay shared.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;

    if (host.startsWith("design.")) {
      const shared = url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico" || url.pathname === "/apple-touch-icon.png";
      if (!shared) {
        url.pathname = "/design" + url.pathname;
      }
      return env.ASSETS.fetch(new Request(url, request));
    }

    // The folder itself lives on its own subdomain.
    if (url.pathname === "/design" || url.pathname.startsWith("/design/")) {
      const target = new URL(url.pathname.replace(/^\/design/, "") || "/", "https://design.masonchambers.com");
      return Response.redirect(target.toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
