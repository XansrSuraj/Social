/* The FM Deliveries viewer is now a page of the site (#/fm), in the same design as the rest.
   An old link — with its filters (?env=prod&since=…&language=…) — lands on the same view there.
   (A file of its own, not inline: the site's Content-Security-Policy runs scripts from this origin only.) */
(function () {
  var q = location.search.replace(/^\?/, "");
  location.replace("/#/fm" + (q ? "?" + q : ""));
})();
