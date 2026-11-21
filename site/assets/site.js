// Copy buttons on code blocks, mobile menus, and the docs table-of-contents highlight.
document.querySelectorAll("pre").forEach((pre) => {
  const b = document.createElement("button");
  b.className = "copy";
  b.type = "button";
  b.textContent = "Copy";
  b.addEventListener("click", async () => {
    const text = pre.querySelector("code")?.innerText ?? pre.innerText;
    try {
      await navigator.clipboard.writeText(text.replace(/^Copy\n?/, "").trim());
      b.textContent = "Copied";
    } catch {
      b.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  });
  pre.appendChild(b);
});

const menu = document.querySelector(".menu-btn");
menu?.addEventListener("click", () => {
  const cls = document.querySelector(".toc") ? "toc-open" : "nav-open";
  document.body.classList.toggle(cls);
  menu.setAttribute("aria-expanded", document.body.classList.contains(cls));
});
document.querySelectorAll(".toc a, .top nav a").forEach((a) =>
  a.addEventListener("click", () => document.body.classList.remove("toc-open", "nav-open")),
);

const links = [...document.querySelectorAll(".toc a[href^='#']")];
if (links.length && "IntersectionObserver" in window) {
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const visible = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
      const first = [...byId.keys()].find((id) => visible.has(id));
      if (first) links.forEach((a) => a.classList.toggle("on", a === byId.get(first)));
    },
    { rootMargin: "-80px 0px -60% 0px" },
  );
  byId.forEach((_a, id) => {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  });
}
