/**
 * Aiko embed widget.
 *
 *   <script src="https://YOUR-SITE.vercel.app/embed.js" data-org="ORG_ID"></script>
 *
 * Optional attributes:
 *   data-theme="light|dark"   colour scheme (default light)
 *   data-show="all|social|web"  which blocks to render (default all)
 *   data-title="false"        hide the organization name
 *
 * Renders read-only. All styles are inline so nothing clashes with the host page.
 */
(function () {
  "use strict";

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName("script");
    return all[all.length - 1];
  })();
  if (!script) return;

  var orgId = script.getAttribute("data-org") || "";
  var dark  = (script.getAttribute("data-theme") || "light") === "dark";
  var show  = script.getAttribute("data-show") || "all";
  var wantTitle = script.getAttribute("data-title") !== "false";

  var base = "";
  try { base = new URL(script.src, location.href).origin; } catch (e) { base = ""; }

  var C = dark
    ? { bg: "#151926", line: "#272c3d", text: "#eaeefb", muted: "#98a1bd", card: "#1b2030" }
    : { bg: "#ffffff", line: "#e7eaf3", text: "#101425", muted: "#666e88", card: "#f8f9fc" };

  var root = document.createElement("div");
  root.setAttribute("data-orghub-embed", orgId || "1");
  root.style.cssText =
    "all:initial;display:block;box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "font-size:14px;line-height:1.5;color:" + C.text + ";background:" + C.bg + ";border:1px solid " + C.line +
    ";border-radius:14px;padding:16px;max-width:640px;";
  root.textContent = "Loading channels…";
  root.style.color = C.muted;

  if (script.parentNode) script.parentNode.insertBefore(root, script.nextSibling);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function safeUrl(u) {
    var s = String(u || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "";
    return "https://" + s.replace(/^\/+/, "");
  }
  function pretty(u) {
    try {
      var x = new URL(safeUrl(u));
      return (x.host.replace(/^www\./, "") + x.pathname).replace(/\/$/, "");
    } catch (e) { return String(u || ""); }
  }
  function initials(n) {
    var p = String(n || "?").trim().split(/\s+/).filter(Boolean);
    return (((p[0] || "?")[0]) + ((p[1] || "")[0] || "")).toUpperCase();
  }

  function link(href, bg, label, sub) {
    return '<a href="' + esc(safeUrl(href)) + '" target="_blank" rel="noopener noreferrer nofollow" ' +
      'style="all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;padding:9px 11px;' +
      'border:1px solid ' + C.line + ';border-radius:10px;background:' + C.card + ';box-sizing:border-box;">' +
        '<span style="width:28px;height:28px;flex:none;border-radius:8px;background:' + esc(bg) + ';color:#fff;' +
          'display:flex;align-items:center;justify-content:center;font:700 11px/1 system-ui,sans-serif;">' +
          esc(initials(label)) + '</span>' +
        '<span style="min-width:0;flex:1;">' +
          '<span style="display:block;font:600 13.5px/1.35 system-ui,sans-serif;color:' + C.text + ';">' + esc(label) + '</span>' +
          '<span style="display:block;font:400 12px/1.35 system-ui,sans-serif;color:' + C.muted + ';overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap;">' + esc(sub) + '</span>' +
        '</span>' +
      '</a>';
  }

  function grid(items) {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;">' +
      items.join("") + '</div>';
  }
  function heading(t) {
    return '<div style="font:700 11px/1 system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:' +
      C.muted + ';margin:0 0 9px;">' + esc(t) + '</div>';
  }

  fetch(base + "/api/data", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var data = res && res.data;
      if (!data || !Array.isArray(data.orgs) || !data.orgs.length) throw new Error("no data");

      var org = orgId ? data.orgs.filter(function (o) { return o.id === orgId; })[0] : data.orgs[0];
      if (!org) throw new Error("org not found");

      var platforms = (data.settings && data.settings.platforms) || [];
      var plat = function (id) {
        return platforms.filter(function (p) { return p.id === id; })[0] ||
               { name: "Channel", color: "#64748b" };
      };

      var html = "";
      if (wantTitle) {
        html += '<div style="font:750 16px/1.3 system-ui,sans-serif;letter-spacing:-.3px;margin:0 0 14px;color:' +
          C.text + ';">' + esc(org.name) + '</div>';
      }
      if (show !== "social" && (org.websites || []).length) {
        html += heading("Websites") + grid(org.websites.map(function (w) {
          return link(w.url, "#5b6bff", w.label || pretty(w.url), pretty(w.url));
        })) + '<div style="height:14px"></div>';
      }
      if (show !== "web" && (org.socials || []).length) {
        html += heading("Social channels") + grid(org.socials.map(function (s) {
          var p = plat(s.platform);
          return link(s.url, p.color, p.name, s.handle || pretty(s.url));
        }));
      }
      html += '<div style="font:400 11px/1.4 system-ui,sans-serif;color:' + C.muted +
        ';margin-top:14px;opacity:.75;">Official channels · kept up to date automatically</div>';

      root.style.color = C.text;
      root.innerHTML = html;
    })
    .catch(function () {
      root.style.color = C.muted;
      root.textContent = "Channels are unavailable right now.";
    });
})();
