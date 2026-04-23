#!/usr/bin/env node
import { program } from 'commander';
import { historyCommand } from './commands/history.js';
import { scanCommand } from './commands/scan.js';
import { visionCommand } from './commands/vision.js';
import { authCommand } from './commands/auth.js';
import { syncCommand } from './commands/sync.js';

program
  .name('alpha-loop')
  .description('Agent-agnostic automated development loop')
  .version('1.8.0');

program
  .command('init')
  .description('Full project onboarding: config, templates, vision, scan, sync')
  .action(async () => {
    const { initCommand } = await import('./commands/init.js');
    await initCommand();
  });

program
  .command('run')
  .description('Run the loop — fetches matching issues and processes them all, then exits')
  .option('--dry-run', 'Preview without changes')
  .option('--model <model>', 'AI model to use')
  .option('--skip-tests', 'Skip test execution')
  .option('--skip-review', 'Skip code review')
  .option('--skip-learn', 'Skip learning extraction')
  .option('--milestone <name>', 'Only process issues in this milestone')
  .option('--auto-merge', 'Auto-merge PRs to session branch')
  .option('--merge-to <branch>', 'Use existing branch instead of creating session branch')
  .option('--once', 'Process one issue and exit')
  .option('--batch', 'Batch mode: process multiple issues per agent call (faster, fewer tokens)')
  .option('--batch-size <n>', 'Issues per batch (default: 5)', parseInt)
  .option('--validate', 'Run pre-session validation on all queued issues before processing')
  .option('--fix', 'Auto-fix validation issues (reorder deps, comment on incomplete issues)')
  .option('--verbose', 'Stream live agent output to terminal')
  .option('--epic <n>', 'Process a specific epic by issue number (skips the picker)', parseInt)
  .option('--skip-epic', 'Skip the epic picker, use flat/milestone flow')
  .option('--verify-only <n>', 'Run only the verification pass on an existing epic', parseInt)
  .action(async (options) => {
    const { runCommand } = await import('./commands/run.js');
    if (options.once) options.maxIssues = 1;
    await runCommand(options);
  });

program
  .command('history [session]')
  .description('View session history')
  .option('--qa', 'Show QA checklist for session')
  .option('--clean', 'Remove old session data')
  .option('--telemetry', 'Show per-stage telemetry for a session')
  .action(historyCommand);

// Report subcommands — routing A/B analysis, cost-per-issue rollups.
const reportCmd = program
  .command('report')
  .description('Generate cross-session reports (routing, cost, telemetry)');

reportCmd
  .command('routing')
  .description('Aggregate per-stage telemetry and cost-per-issue across sessions')
  .option('--profile <name>', 'Filter to entries with this routing profile')
  .option('--since <duration>', 'Limit window (e.g. 30d, 12h, 45m)')
  .option('--json', 'Emit machine-readable JSON instead of a table')
  .action(async (options) => {
    const { reportRoutingCommand } = await import('./commands/report.js');
    reportRoutingCommand(options);
  });

program
  .command('scan')
  .description('Generate/refresh project context')
  .action(scanCommand);

program
  .command('vision')
  .description('(deprecated) Interactive project vision setup — use "plan" instead')
  .action(visionCommand);

program
  .command('auth')
  .description('Save authenticated browser state')
  .action(authCommand);

program
  .command('sync')
  .description('Sync .alpha-loop/templates/ to all configured harnesses')
  .option('--check', 'Check for drift without syncing (exits non-zero if drift found)')
  .action(syncCommand);

program
  .command('plan')
  .description('Generate a full project scope (milestones + issues) from seed inputs using AI')
  .option('--seed <file>', 'Read seed description from a file instead of prompting')
  .option('--no-vision', 'Skip vision generation even if no vision exists')
  .option('--dry-run', 'Display the plan without creating any GitHub resources')
  .option('-y, --yes', 'Skip interactive prompts, accept all AI recommendations')
  .option('--resume', 'Resume from a previously saved plan draft (.alpha-loop/plan.json)')
  .action(async (options) => {
    const { planCommand } = await import('./commands/plan.js');
    await planCommand(options);
  });

program
  .command('add')
  .description('Create a new issue from a free-form description using AI')
  .option('--seed <file>', 'Read description from a file instead of prompting')
  .option('--milestone <name>', 'Override milestone assignment')
  .option('--dry-run', 'Preview the issue without creating it')
  .option('-y, --yes', 'Skip interactive prompts, create directly')
  .action(async (options) => {
    const { addCommand } = await import('./commands/add.js');
    await addCommand(options);
  });

program
  .command('triage')
  .description('Analyze and improve existing issues (staleness, clarity, size, duplicates)')
  .option('--dry-run', 'Display findings without making changes')
  .option('-y, --yes', 'Skip interactive prompts, accept all AI recommendations')
  .action(async (options) => {
    const { triageCommand } = await import('./commands/triage.js');
    await triageCommand(options);
  });

program
  .command('roadmap')
  .description('Organize open issues into milestones using AI analysis')
  .option('--dry-run', 'Display proposed roadmap without making changes')
  .option('-y, --yes', 'Skip interactive prompts, accept all AI recommendations')
  .action(async (options) => {
    const { roadmapCommand } = await import('./commands/roadmap.js');
    await roadmapCommand(options);
  });

program
  .command('resume')
  .description('Resume stranded work — push branches, run review, open PRs')
  .option('--issue <num>', 'Only resume a specific issue number')
  .option('--session <name>', 'Resume from a specific session directory')
  .action(async (options) => {
    const { resumeCommand } = await import('./commands/resume.js');
    await resumeCommand(options);
  });

program
  .command('learn')
  .description('Backfill learnings from existing session traces')
  .option('--session <name>', 'Only process a specific session (supports partial match)')
  .option('--dry-run', 'Show what would be extracted without running agents')
  .action(async (options) => {
    const { learnCommand } = await import('./commands/learn.js');
    await learnCommand(options);
  });

program
  .command('review')
  .description('Analyze accumulated learnings and propose self-improvements to agents, skills, and config')
  .option('--apply', 'Apply proposed changes and open a draft PR')
  .option('--session <name>', 'Only analyze learnings from a specific session')
  .action(async (options) => {
    const { reviewCommand } = await import('./commands/review.js');
    await reviewCommand(options);
  });

// Eval subcommands
const evalCmd = program
  .command('eval')
  .description('Run eval suite, capture failures, list cases, view scores');

evalCmd
  .command('run', { isDefault: true })
  .description('Run the eval suite and compute composite score')
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('--suite <suite>', 'Run only a suite: step (fast) or e2e (slow)')
  .option('--case <id>', 'Run a single eval case by ID prefix')
  .option('--type <type>', 'Filter by type: full or step')
  .option('--step <step>', 'Filter by pipeline step (plan, implement, test, test-fix, review, verify, learn, skill)')
  .option('--verbose', 'Show detailed output')
  .option('--profile <name>', 'Apply a routing profile (name or path) before running')
  .option('--matrix', 'Run every case under each profile and emit an A/B comparison report (dry-run by default)')
  .option('--profiles <list>', 'Comma-separated profile names/paths for --matrix (default: all-frontier,hybrid-v1,all-local)')
  .option('--baseline <name>', 'Baseline profile for delta computation (default: all-frontier)')
  .option('--out <dir>', 'Output directory for matrix reports (default: eval/reports)')
  .option('--execute', 'Actually run pipelines for --matrix (otherwise validates structure only; see CASE_FORMAT.md for why this is gated)')
  .action(async (options) => {
    const { evalRunCommand } = await import('./commands/eval.js');
    await evalRunCommand(options);
  });

evalCmd
  .command('capture [issue]')
  .description('Capture failures as eval cases (interactive)')
  .option('--quality', 'Capture quality failures from successful sessions (false positives)')
  .option('--session <name>', 'Filter to a specific session')
  .action(async (issue, options) => {
    const { evalCaptureCommand } = await import('./commands/eval.js');
    await evalCaptureCommand({ issue, quality: options.quality, session: options.session });
  });

evalCmd
  .command('list')
  .description('Show eval cases and recent scores')
  .action(async () => {
    const { evalListCommand } = await import('./commands/eval.js');
    evalListCommand();
  });

evalCmd
  .command('scores')
  .description('Show score history over time')
  .action(async () => {
    const { evalScoresCommand } = await import('./commands/eval.js');
    evalScoresCommand();
  });

evalCmd
  .command('search')
  .description('Greedy coordinate descent search over model/agent configurations')
  .option('--models <models>', 'Models to test (comma-separated)')
  .option('--agents <agents>', 'Agents to test (comma-separated)')
  .option('--max-runs <n>', 'Maximum number of eval runs')
  .option('--budget <n>', 'Maximum number of eval runs (alias for --max-runs)')
  .option('--step <step>', 'Only search over this pipeline step')
  .option('--min-score <score>', 'Minimum acceptable score threshold')
  .option('--optimize <target>', 'Optimize for: cost or efficiency (default: efficiency)')
  .action(async (options) => {
    const { evalSearchCommand } = await import('./commands/eval.js');
    await evalSearchCommand(options);
  });

evalCmd
  .command('pareto')
  .description('Show score/cost Pareto frontier')
  .action(async () => {
    const { evalParetoCommand } = await import('./commands/eval.js');
    evalParetoCommand();
  });

evalCmd
  .command('compare <run1> <run2>')
  .description('Compare two eval runs showing per-case changes')
  .action(async (run1: string, run2: string) => {
    const { evalCompareCommand } = await import('./commands/eval.js');
    evalCompareCommand(run1, run2);
  });

evalCmd
  .command('estimate')
  .description('Estimate cost of running the eval suite with current or specified config')
  .option('--config <path>', 'Path to a YAML config file to estimate')
  .action(async (options) => {
    const { evalEstimateCommand } = await import('./commands/eval.js');
    evalEstimateCommand(options);
  });

evalCmd
  .command('compare-configs <configA> <configB>')
  .description('Compare two YAML config files side-by-side')
  .action(async (configA: string, configB: string) => {
    const { evalCompareConfigsCommand } = await import('./commands/eval.js');
    evalCompareConfigsCommand(configA, configB);
  });

evalCmd
  .command('import-swebench')
  .description('Import eval cases from SWE-bench dataset')
  .option('--dataset <path>', 'Path to a downloaded JSONL file (skips auto-download)')
  .option('--dataset-id <id>', 'HuggingFace dataset ID (default: princeton-nlp/SWE-bench_Lite)')
  .option('--count <n>', 'Maximum number of cases to import')
  .option('--repo <owner/repo>', 'Filter by repository (e.g. django/django)')
  .option('--ids <csv>', 'Import specific instance IDs (comma-separated)')
  .option('--step <step>', 'Pipeline step to target (default: implement)')
  .action(async (options) => {
    const { evalImportSwebenchCommand } = await import('./commands/eval.js');
    await evalImportSwebenchCommand(options);
  });

evalCmd
  .command('export <case>')
  .description('Export an eval case for contributing back to alpha-loop')
  .option('--no-anonymize', 'Skip anonymization of project-specific details')
  .option('--output <dir>', 'Output directory (default: .alpha-loop-contrib/)')
  .option('--pr', 'Show instructions for submitting a PR')
  .action(async (caseId: string, options: { anonymize?: boolean; output?: string; pr?: boolean }) => {
    const { evalExportCommand } = await import('./commands/eval.js');
    evalExportCommand(caseId, options);
  });

evalCmd
  .command('convert')
  .description('Convert between AlphaLoop eval format and skill-creator format')
  .option('--direction <dir>', 'Conversion direction: to-skill or from-skill (default: to-skill)')
  .option('--input <path>', 'Input file path (for from-skill)')
  .option('--output <path>', 'Output file path')
  .action(async (options) => {
    const { evalConvertCommand } = await import('./commands/eval.js');
    evalConvertCommand(options);
  });

program
  .command('evolve')
  .description('Meta-Harness-style automated optimization loop')
  .option('--max-iterations <n>', 'Maximum optimization iterations (default: 5)')
  .option('--continuous', 'Run until manually stopped (SIGINT)')
  .option('--surface <level>', 'Optimization surface: prompts, skills, config, all (default: prompts)')
  .option('--resume', 'Resume from a previous evolve session')
  .option('--dry-run', 'Preview without making changes')
  .option('--verbose', 'Show detailed agent output')
  .action(async (options) => {
    const { evolveCommand } = await import('./commands/evolve.js');
    await evolveCommand(options);
  });

program.parse();
