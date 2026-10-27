#!/usr/bin/env node
import { Command } from 'commander'

const program = new Command()

program
  .name('flowproof')
  .description('Local evidence-grounded fix verification')
  .version('0.1.0')

program
  .command('studio')
  .description('Open the local split-view FlowProof Studio')
  .option('--scenario <scenario-id>', 'committed scenario identifier')
  .action(() => {
    process.stderr.write('STUDIO_NOT_IMPLEMENTED: the Studio launcher is not implemented yet.\n')
    process.exitCode = 4
  })

program.parse()
