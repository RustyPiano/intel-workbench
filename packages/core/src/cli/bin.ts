#!/usr/bin/env node

import process from "node:process";

import { CliError, main, printHelp } from "./main.js";

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    printHelp();
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
