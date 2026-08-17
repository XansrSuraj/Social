/**
 * Aiko embed widget.
 *
 *   <script src="https://YOUR-SITE.vercel.app/embed.js" data-org="ORG_ID"></script>
 *
 * Optional attributes:
 *   data-theme="light|dark"   colour scheme (default light)
 *   data-show="all|social|web"  which blocks to render (default all)
 *   data-group="region|platform|language"  what the blocks are (default region)
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
  var group = script.getAttribute("data-group") || "region";
  var wantTitle = script.getAttribute("data-title") !== "false";
  if (["region", "platform", "language"].indexOf(group) === -1) group = "region";

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

  /* Region names come out of the browser rather than off the wire — Intl already knows all
     ~250 of them offline, so the widget stays a single file with no data to ship or refresh. */
  var REGION = null;
  try { REGION = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }); } catch (e) {}
  function regionName(code) {
    var cc = String(code || "").trim().toUpperCase();
    if (!cc) return "";
    var nm = "";
    try { nm = (REGION && REGION.of(cc)) || ""; } catch (e) {}
    return nm || cc;
  }
  /* an image, not an emoji flag: Windows ships no flag glyphs, so 🇻🇳 renders there as "VN" */
  function flag(code) {
    var cc = String(code || "").trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) return "";
    return '<img src="https://flagcdn.com/w40/' + cc + '.png" alt="" loading="lazy" ' +
      'style="width:19px;height:14px;flex:none;object-fit:cover;border-radius:2px;display:block;">';
  }

  /* The widget mirrors the directory itself: one block per region, its channels listed by
     language inside. Grouping happens here rather than server-side, so an embed on an old
     page picks the new shape up the moment this file is redeployed. */
  var DIMS = {
    region:   { key: function (s) { return String(s.region || "").trim().toUpperCase(); } },
    language: { key: function (s) { return String(s.language || "").trim(); } },
    platform: { key: function (s) { return s.platform || ""; } },
  };
  var SUBDIM = { region: "language", language: "region", platform: "region" };

  function bucket(list, dim) {
    var out = [], index = {};
    list.forEach(function (s) {
      var k = DIMS[dim].key(s);
      if (!(k in index)) { index[k] = out.length; out.push({ value: k, items: [] }); }
      out[index[k]].items.push(s);
    });
    return out;
  }
  /* named values first and alphabetical; the unset ones sink to the bottom of every list */
  function sortBy(list, label) {
    return list.sort(function (a, b) {
      var x = label(a.value), y = label(b.value);
      if (!x !== !y) return x ? -1 : 1;
      return String(x).localeCompare(String(y));
    });
  }

  function cluster(socials, mode, plat, order) {
    var sub = SUBDIM[mode];
    var rank = function (id) { var i = order.indexOf(id); return i < 0 ? 9e3 : i; };
    var label = function (dim) {
      return dim === "region" ? regionName
        : dim === "platform" ? function (v) { return plat(v).name; }
        : function (v) { return v; };
    };
    var groups = bucket(socials, mode);
    if (mode === "platform") groups.sort(function (a, b) { return rank(a.value) - rank(b.value); });
    else sortBy(groups, label(mode));

    groups.forEach(function (g) {
      g.sections = sortBy(bucket(g.items, sub), label(sub));
      g.sections.forEach(function (sec) {
        sec.items.sort(function (x, y) { return rank(x.platform) - rank(y.platform); });
      });
    });
    return groups;
  }

  /* Platform names, languages and country names are all free-width, and this widget renders on
     somebody else's page where we control nothing about the space available. Every text cell
     therefore caps its own width and ellipsises, so one long value can never crowd out the
     link beside it or get hard-clipped by the block's own overflow:hidden. */
  var CLIP = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  function block(g, mode, plat) {
    var sub = SUBDIM[mode];
    var head, dot = "";
    if (mode === "region") {
      head = regionName(g.value) || "No region";
      dot = flag(g.value);
    } else if (mode === "platform") {
      var p = plat(g.value);
      head = p.name;
      dot = '<span style="width:9px;height:9px;flex:none;border-radius:3px;background:' +
        esc(p.color || "#64748b") + ';"></span>';
    } else {
      head = g.value || "No language";
    }

    var body = g.sections.map(function (sec) {
      var band = "";
      /* one section is the whole block — its own band would only repeat the heading */
      if (g.sections.length > 1) {
        var t = sub === "region" ? (regionName(sec.value) || "No region") : (sec.value || "No language");
        band = '<div style="display:flex;align-items:center;gap:7px;padding:7px 11px;' +
          'border-top:1px solid ' + C.line + ';background:' + C.card + ';">' +
          (sub === "region" ? flag(sec.value) : "") +
          '<span style="min-width:0;flex:1;' + CLIP + 'font:700 11px/1.3 system-ui,sans-serif;color:' + C.muted + ';">' +
            esc(t) + '</span>' +
          '<span style="flex:none;font:700 11px/1 system-ui,sans-serif;color:' + C.muted + ';">' + sec.items.length + '</span>' +
          '</div>';
      }
      return band + sec.items.map(function (s) {
        /* whichever dimension the heading and the band have not already named */
        var lead = (sub === "language" || mode === "language") ? plat(s.platform).name
                 : String(s.language || "").trim();
        return '<a href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener noreferrer nofollow" ' +
          'style="all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;padding:8px 11px;' +
          'border-top:1px solid ' + C.line + ';box-sizing:border-box;">' +
            '<span style="flex:none;min-width:74px;max-width:40%;' + CLIP +
              'font:600 12px/1.35 system-ui,sans-serif;color:' + (lead ? C.text : C.muted) + ';">' +
              esc(lead || "—") + '</span>' +
            '<span style="min-width:0;flex:1;' + CLIP + 'font:400 12px/1.35 system-ui,sans-serif;color:' + C.muted + ';">' +
              esc(s.handle || pretty(s.url)) + '</span>' +
          '</a>';
      }).join("");
    }).join("");

    return '<div style="margin-bottom:10px;border:1px solid ' + C.line + ';border-radius:12px;overflow:hidden;">' +
        '<div style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-bottom:1px solid ' + C.line + ';">' +
          dot +
          '<span style="min-width:0;flex:1;' + CLIP + 'font:700 13px/1.3 system-ui,sans-serif;color:' + C.text + ';">' +
            esc(head) + '</span>' +
          '<span style="flex:none;font:700 11px/1 system-ui,sans-serif;color:' + C.muted + ';">' + g.items.length + '</span>' +
        '</div>' + body +
      '</div>';
  }

  fetch(base + "/api/data", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var data = res && res.data;
      if (!data || !Array.isArray(data.orgs) || !data.orgs.length) throw new Error("no data");

      var org = orgId ? data.orgs.filter(function (o) { return o.id === orgId; })[0] : data.orgs[0];
      if (!org) throw new Error("org not found");

      var platforms = (data.settings && data.settings.platforms) || [];
      /* A channel can name a platform that settings does not describe — a cloud row written
         by an older version, or a platform deleted after the fact. One shared fallback would
         collapse every such channel into a single nameless block, so key on the id itself and
         make a readable name out of it. Facebook still groups as Facebook either way. */
      var NAMES = { x: "X", gbp: "Google Business", tiktok: "TikTok", youtube: "YouTube",
                    linkedin: "LinkedIn", whatsapp: "WhatsApp", other: "Other channel" };
      var label = function (id) {
        if (!id) return "Channel";
        return NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1));
      };
      var plat = function (id) {
        return platforms.filter(function (p) { return p.id === id; })[0] ||
               { id: id || "other", name: label(id), color: "#64748b" };
      };
      var order = platforms.map(function (p) { return p.id; });

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
        /* Region-grouped is the default, but an org that has not filled any region in would
           get one nameless block holding everything — fall back to platform for those. */
        var mode = group;
        if (mode === "region" && !org.socials.some(function (s) { return String(s.region || "").trim(); }))
          mode = "platform";
        html += heading("Social channels") +
          cluster(org.socials, mode, plat, order).map(function (g) { return block(g, mode, plat); }).join("");
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
