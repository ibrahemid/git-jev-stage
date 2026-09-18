#!/usr/bin/env node
import { main } from "../dist/git-jev-stage.js";

process.exitCode = await main(process.argv.slice(2));
