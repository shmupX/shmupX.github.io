import { Head } from "fresh/runtime";
import { define } from "../utils.ts";

export default define.page(function Home() {
  return (
    <>
      <Head>
        <title>codemonkey.games — shmupX</title>
        {
          /* Self-hosted (static/fonts/) so the packaged launcher paints the
             same offline; a Google Fonts <link> here blocked first paint for
             as long as an unreachable host took to time out. */
        }
        <link
          key="font-orbitron"
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/orbitron-latin.woff2"
          crossorigin="anonymous"
        />
        <link
          key="font-share-tech-mono"
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/share-tech-mono-latin.woff2"
          crossorigin="anonymous"
        />
        <link key="fonts" rel="stylesheet" href="/fonts/launcher.css" />
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
