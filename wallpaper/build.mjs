import esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const out = "wallpaper/dist";
mkdirSync(out, { recursive: true });
await esbuild.build({
	entryPoints: ["wallpaper/main.ts"],
	bundle: true,
	format: "iife",
	target: "es2020",
	minify: true,
	logLevel: "info",
	outfile: `${out}/wallpaper.js`,
});
for (const f of ["index.html", "project.json"]) cpSync(`wallpaper/${f}`, `${out}/${f}`);
cpSync("styles.css", `${out}/styles.css`);
console.log(`Wallpaper pronto em ${out}/`);
