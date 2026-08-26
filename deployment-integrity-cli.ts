import {runProductionCli} from './deployment-integrity.ts';

process.exitCode = await runProductionCli(process.argv.slice(2));
