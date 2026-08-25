import { Head } from "fresh/runtime";
import { define } from "../utils.ts";

export default define.page(function Home() {
  return (
    <>
      <Head>
        <title>codemonkey.games — shmupX</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossorigin="anonymous"
        />
        <link
          key="fonts"
          href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@500;700;800&display=swap"
          rel="stylesheet"
        />
        <link key="dashboard-css" rel="stylesheet" href="/dashboard.css" />
        <link
          key="manifest"
          rel="manifest"
          href="/app-icons/manifest.webmanifest"
        />
        <link
          key="favicon"
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/app-icons/icon-32.png"
        />
        <link
          key="apple-touch"
          rel="apple-touch-icon"
          href="/app-icons/ios/icon-180.png"
        />
        <meta key="theme-color" name="theme-color" content="#000000" />
      </Head>
      <div id="app-root"></div>
      <script src="/gamepad-compatibility-plugin.js"></script>
      <script type="module" src="/dashboard.bundle.js"></script>
      <script type="module" src="/gamepad-support.js"></script>
      <script type="module" src="/controller-configurator.js"></script>
      <script type="module" src="/controller-mapping-wizard.js"></script>
    </>
  );
});
