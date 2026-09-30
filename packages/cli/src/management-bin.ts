#!/usr/bin/env bun
/** Native, trusted-host-only entrypoint. Never expose this executable to an agent. */
import { runManagement } from "./management-commands.ts";
process.exitCode = await runManagement(process.argv.slice(2));
