import {
  InvalidSessionTransitionError,
  applyHumanFeedbackTransition,
  classifyFeedback,
  formatHumanInputComment,
  formatQaRequestComment,
  githubLabelChangesForStatus,
  mapLabelsToHumanFeedbackStatus,
} from '../../src/lib/session-state.js';

describe('human feedback session state machine', () => {
  it('persists a typed human input transition with question and event metadata', () => {
    const manifest = {
      status: 'running',
      stage: 'implement',
      lastEventId: null as string | null,
    };

    const next = applyHumanFeedbackTransition(manifest, {
      to: 'human_input_requested',
      reason: 'Need product clarification',
      issueNum: 285,
      question: 'Which variant should be implemented?',
      resumeInstructions: 'Resume once the variant is confirmed.',
      at: '2026-05-30T12:00:00.000Z',
    });

    expect(next.status).toBe('human_input_requested');
    expect(next.stage).toBe('human_input_requested');
    expect(next.feedback.currentStatus).toBe('human_input_requested');
    expect(next.feedback.question).toBe('Which variant should be implemented?');
    expect(next.feedback.resumeInstructions).toBe('Resume once the variant is confirmed.');
    expect(next.feedback.transitionHistory).toEqual([
      expect.objectContaining({
        from: 'running',
        to: 'human_input_requested',
        issueNum: 285,
      }),
    ]);
    expect(next.feedback.events).toEqual([
      expect.objectContaining({
        type: 'human_input',
        status: 'human_input_requested',
        issueNum: 285,
      }),
    ]);
    expect(next.lastEventId).toBe(next.feedback.events[0].id);
  });

  it('rejects invalid transitions', () => {
    expect(() => applyHumanFeedbackTransition(
      { status: 'running', stage: 'implement' },
      {
        to: 'feedback_received',
        reason: 'Feedback cannot arrive before a wait state',
      },
    )).toThrow(InvalidSessionTransitionError);
  });

  it('can enter feedback_received from a waiting state with a classification', () => {
    const waiting = applyHumanFeedbackTransition(
      { status: 'running', stage: 'implement' },
      {
        to: 'human_input_requested',
        reason: 'Need a decision first',
        at: '2026-05-30T12:00:00.000Z',
      },
    );

    const feedback = applyHumanFeedbackTransition(waiting, {
      to: 'feedback_received',
      reason: 'Human requested a copy change',
      classification: 'change_request',
      at: '2026-05-30T12:05:00.000Z',
    });

    expect(feedback.status).toBe('feedback_received');
    expect(feedback.feedback.currentStatus).toBe('feedback_received');
    expect(feedback.feedback.classification).toBe('change_request');
    expect(feedback.feedback.transitionHistory.map((entry) => entry.to)).toEqual([
      'human_input_requested',
      'feedback_received',
    ]);
  });

  it('maps GitHub labels and requested states without treating labels as the only source of truth', () => {
    expect(mapLabelsToHumanFeedbackStatus(['ready'])).toBe('resume_requested');
    expect(mapLabelsToHumanFeedbackStatus(['in-progress'])).toBe('running');
    expect(mapLabelsToHumanFeedbackStatus(['in-review'])).toBe('qa_requested');
    expect(mapLabelsToHumanFeedbackStatus(['needs-human-input'])).toBe('human_input_requested');

    expect(githubLabelChangesForStatus('qa_requested')).toEqual([
      { add: 'in-review', remove: 'in-progress' },
      { add: 'needs-human-input', remove: 'ready' },
    ]);
  });

  it('formats concrete human input and QA comments', () => {
    expect(formatHumanInputComment({
      question: 'Which pricing tier should be shown?',
      resumeInstructions: 'Resume after the pricing tier is confirmed.',
      sessionName: 'session/20260530-120000',
      branch: 'agent/issue-285',
    })).toContain('Which pricing tier should be shown?');

    const qa = formatQaRequestComment({
      checklist: ['Open the preview', 'Confirm the CTA copy'],
      prUrl: 'https://github.com/owner/repo/pull/5',
    });
    expect(qa).toContain('- [ ] Open the preview');
    expect(qa).toContain('https://github.com/owner/repo/pull/5');
  });

  it('classifies common feedback intents', () => {
    expect(classifyFeedback('LGTM, approved')).toBe('approval');
    expect(classifyFeedback('Please change the button copy')).toBe('change_request');
    expect(classifyFeedback('QA failed: the checkout flow is broken')).toBe('change_request');
    expect(classifyFeedback('Also add a settings page as a follow-up')).toBe('new_scope');
    expect(classifyFeedback('Do not proceed with this')).toBe('rejection');
    expect(classifyFeedback('Use the shorter CTA copy.')).toBe('clarification');
    expect(classifyFeedback('Which branch is this using?')).toBe('clarification');
    expect(classifyFeedback('Thanks for the update.')).toBe('unknown');
    expect(classifyFeedback('')).toBe('unknown');
  });
});
