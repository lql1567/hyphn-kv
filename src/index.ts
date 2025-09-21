export default {
  async fetch(request: any) {
    console.log(`recv request:${request}`)
    const url = new URL(request.url);
    if (url.pathname === '/blog') {
      return Response.redirect(`${url.origin}/blog/`, 301);
    }
    const target = new URL(request.url);
    target.hostname = 'hpyhn-blog.pages.dev'; // 你的 pages.dev
    target.pathname = url.pathname.replace(/^\/blog(\/|$)/, '/');
    const newReq = new Request(target.toString(), request);
    return fetch(newReq, { redirect: 'follow' });
  }
}