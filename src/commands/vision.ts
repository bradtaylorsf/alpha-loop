import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { exec } from '../lib/shell.js';
import { assertSafeShellArg, loadConfig } from '../lib/config.js';
import { logInfo, logStep, logSuccess, logWarn } from '../lib/logger.js';

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

const USER_TYPES: Record<string, string> = {
  '1': 'Technical users (developers, engineers)',
  '2': 'Semi-technical (power users, admins)',
  '3': 'Non-technical (general consumers, elderly, caregivers) \u2014 UI must be simple, accessible, and forgiving',
  '4': 'Mixed audience \u2014 needs both simple and advanced interfaces',
};

const STAGES: Record<string, string> = {
  '1': 'Brand new / greenfield \u2014 focus on getting core architecture right',
  '2': 'MVP / early development \u2014 focus on core flows working end-to-end',
  '3': 'Working product \u2014 adding features without breaking existing functionality',
  '4': 'Mature product \u2014 maintenance, optimization, and careful changes',
};

const PRIORITIES: Record<string, string> = {
  '1': 'Core functionality \u2014 make it work reliably before making it pretty',
  '2': 'User experience \u2014 the product works, now make it delightful',
  '3': 'Scale and performance \u2014 handle more load, optimize bottlenecks',
  '4': 'Security and compliance \u2014 harden, audit, meet regulatory requirements',
};

export async function visionCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    logInfo('Not running in an interactive terminal. Skipping vision setup.');
    return;
  }

  const projectDir = process.cwd();
  const contextDir = path.join(projectDir, '.alpha-loop');
  const visionFile = path.join(contextDir, 'vision.md');
  const config = loadConfig(projectDir);

  fs.mkdirSync(contextDir, { recursive: true });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Check if vision exists
    if (fs.existsSync(visionFile)) {
      console.log('');
      console.log('\x1b[1mCurrent project vision:\x1b[0m');
      console.log('');
      console.log(fs.readFileSync(visionFile, 'utf-8'));
      console.log('');
      const updateChoice = await ask(rl, 'Update this vision? [y/N]: ');
      if (updateChoice.toLowerCase() !== 'y') {
        return;
      }
    } else {
      console.log('');
      console.log('\x1b[1m\x1b[36mNo project vision found. Let\'s set one up.\x1b[0m');
      console.log('This helps the agent understand what it\'s building and make better decisions.');
      console.log('');
    }

    // Question 1: What is this project?
    console.log('\x1b[1mWhat is this project?\x1b[0m (1-2 sentences)');
    const projectDescription = await ask(rl, '> ');
    console.log('');

    // Question 2: Target users
    console.log('\x1b[1mWho are the target users?\x1b[0m');
    console.log('  [1] Technical users (developers, engineers)');
    console.log('  [2] Semi-technical (power users, admins)');
    console.log('  [3] Non-technical (general consumers, elderly, caregivers)');
    console.log('  [4] Mixed audience');
    const userTypeChoice = await ask(rl, '> ');
    const userType = USER_TYPES[userTypeChoice] ?? userTypeChoice;
    console.log('');

    // Question 3: Project stage
    console.log('\x1b[1mWhat stage is the project in?\x1b[0m');
    console.log('  [1] Brand new / greenfield');
    console.log('  [2] MVP / early development');
    console.log('  [3] Working product, adding features');
    console.log('  [4] Mature product, maintenance mode');
    const stageChoice = await ask(rl, '> ');
    const projectStage = STAGES[stageChoice] ?? stageChoice;
    console.log('');

    // Question 4: Current priority
    console.log('\x1b[1mWhat matters most right now?\x1b[0m');
    console.log('  [1] Core functionality works reliably');
    console.log('  [2] User experience and polish');
    console.log('  [3] Scale and performance');
    console.log('  [4] Security and compliance');
    console.log('  [5] Something else (type it)');
    const priorityChoice = await ask(rl, '> ');
    const priority = PRIORITIES[priorityChoice] ?? priorityChoice;
    console.log('');

    // Question 5: UX/design guidelines
    console.log('\x1b[1mAny UX or design guidelines?\x1b[0m (press Enter to skip)');
    console.log("  Examples: 'mobile-first', 'dark mode', 'WCAG AA accessible', 'minimal UI'");
    const uxGuidelines = await ask(rl, '> ');
    console.log('');

    // Question 6: North star issue
    console.log('\x1b[1mLink a north star issue or paste additional context?\x1b[0m');
    console.log('  Paste a GitHub issue URL, issue number, or freeform text (Enter to skip)');
    const northStarInput = await ask(rl, '> ');
    console.log('');

    let northStarContent = '';
    if (northStarInput) {
      const issueMatch = northStarInput.match(/^(\d+)$/) ?? northStarInput.match(/issues\/(\d+)/);
      if (issueMatch) {
        const issueNum = issueMatch[1];
        logInfo(`Fetching issue #${issueNum}...`);
        try {
          const repo = assertSafeShellArg(config.repo, 'repo');
          const issueJson = exec(`gh issue view ${issueNum} --repo ${repo} --json title,body`);
          const issueData = JSON.parse(issueJson);
          northStarContent = `### North Star: #${issueNum} \u2014 ${issueData.title}\n\n${issueData.body}`;
          logSuccess(`Fetched issue #${issueNum}: ${issueData.title}`);
        } catch {
          logWarn(`Could not fetch issue #${issueNum}`);
          northStarContent = northStarInput;
        }
      } else {
        northStarContent = northStarInput;
      }
    }

    // Question 7: Anything else?
    console.log('\x1b[1mAnything else the agent should always keep in mind?\x1b[0m (Enter to skip)');
    const additionalContext = await ask(rl, '> ');
    console.log('');

    // Synthesize with Claude
    logStep('Generating project vision...');

    const visionPrompt = `Synthesize the following inputs into a concise project vision document. This will be read by AI agents before every task to guide their decisions.

Project description: ${projectDescription}
Target users: ${userType}
Project stage: ${projectStage}
Current priority: ${priority}
UX guidelines: ${uxGuidelines || 'None specified'}
Additional context: ${additionalContext || 'None'}
${northStarContent ? `\nNorth star context:\n${northStarContent}` : ''}

Output ONLY this markdown structure. Be specific and actionable. Under 500 words total.

## What We're Building
(2-3 sentences synthesizing the project description and north star)

## Who It's For
(Target users and what that means for UX/design decisions)

## Current Stage & Priority
(Where the project is and what matters most right now)

## Decision Guidelines
(5-7 bullet points the agent should follow when making choices about implementation, UX, what to build vs defer, etc. Derived from all inputs above.)

## What Good Looks Like
(3-4 bullet points describing the quality bar — what a successful implementation looks like for this project)`;

    try {
      const model = assertSafeShellArg(config.model ?? 'opus', 'model');
      const visionOutput = exec(
        `echo ${JSON.stringify(visionPrompt)} | claude -p --model ${model} --dangerously-skip-permissions --output-format text 2>/dev/null`,
        { cwd: projectDir },
      );

      if (visionOutput) {
        fs.writeFileSync(visionFile, visionOutput + '\n');
      } else {
        throw new Error('Empty output');
      }
    } catch {
      // Fallback: write raw inputs
      logWarn('Claude synthesis failed, saving raw inputs');
      const raw = [
        '## What We\'re Building',
        projectDescription,
        '',
        '## Who It\'s For',
        userType,
        '',
        '## Current Stage & Priority',
        projectStage,
        `Priority: ${priority}`,
        '',
        '## UX Guidelines',
        uxGuidelines || 'None specified',
        '',
        ...(northStarContent ? ['## North Star', northStarContent, ''] : []),
        ...(additionalContext ? ['## Additional Context', additionalContext, ''] : []),
      ].join('\n');
      fs.writeFileSync(visionFile, raw + '\n');
    }

    logSuccess(`Project vision saved to ${visionFile}`);
    console.log('');
    console.log(fs.readFileSync(visionFile, 'utf-8'));
  } finally {
    rl.close();
  }
}
