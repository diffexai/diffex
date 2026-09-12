#!/usr/bin/env node
import { readFileSync } from "node:fs";
const { commit } = JSON.parse(readFileSync(process.env.DIFFEX_PUBLICATION_FIXTURE, "utf8"));
const args = process.argv.slice(2);
if (args.join(" ") === "rev-parse HEAD") console.log(commit);
else if (args.join(" ") === "rev-parse HEAD^{tree}") console.log("c".repeat(40));
else throw new Error("Unmocked publication Git request");
