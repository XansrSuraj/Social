import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./report.css";
import "./ops.css";
import { useEffect } from "react";
import { EngineProvider, useApp } from "./app/core.jsx";
import { Nav, Footer } from "./app/Shell.jsx";
import Home from "./pages/Home.jsx";
import Report from "./pages/Report.jsx";
import Live from "./pages/Live.jsx";
import Health from "./pages/Health.jsx";
import Fm from "./pages/Fm.jsx";
import Login from "./pages/Login.jsx";

function App() {
  const { route: full, brand, admin } = useApp();
  /* a page may keep its view in the hash query (#/fm?env=prod&…) — routing looks at the path only */
  const route = full.split("?")[0];
  const isReport = route === brand.base + "/report" || route.startsWith(brand.base + "/report/");
  const PAGES = { "/live": [Live, "Live pipeline"], "/admin": [Health, "Admin"], "/health": [Health, "Admin"], "/fm": [Fm, "FM Deliveries"] };
  /* the admin's pages: behind the sign-in (src/app/admin.js; the server refuses their data without it too) */
  const ADMIN_ONLY = { "/admin": "the admin dashboard", "/health": "the admin dashboard", "/fm": "FM Deliveries" };
  const page = PAGES[route];
  useEffect(() => { document.title = page ? `${page[1]} — SportsFC` : `${brand.name} — Daily check`; }, [brand.name, route]); // eslint-disable-line react-hooks/exhaustive-deps
  const Gate = () => <Login what={ADMIN_ONLY[route]} />;
  const Page = ADMIN_ONLY[route] && !admin ? Gate : page ? page[0] : isReport ? Report : Home;
  /* key on the brand: switching brands starts the page fresh (tabs, filters) rather than carrying
     one brand's view state into the other */
  return (
    <>
      <Nav route={route} />
      <main key={brand.id}><Page /></main>
      <Footer />
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><EngineProvider><App /></EngineProvider></React.StrictMode>
);
