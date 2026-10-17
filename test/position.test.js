/* eslint no-unused-expressions: "off" */
/* eslint-env jest */

'use strict';

import bondage from '../src/index';

const FRESH = (gold) => {
  return `title: Start
---
Intro
<<set $gold to ${gold}>>
<<if $gold > 3>>
  Rich
  -> Buy
    Bought
    <<set $gold to 0>>
    -> Haggle
      Haggled
    -> Pay
      Paid
    After inner
  -> Leave
    Left
  Shop done
<<elseif $gold > 1>>
  Modest
<<else>>
  Poor
<<endif>>
Between
<<if $gold == 0>>
  Broke
<<endif>>
<<mycommand>>
-> Final one
  Final text
-> Final two
  Other text
Outro
<<jump Next>>
===
title: Next
---
<<set $x to 1>>
Next line
<<if $x == 1>>
  <<if $gold == 0>>
    Nested yes
  <<endif>>
<<endif>>
Last
<<stop>>
Not shown
===
`;
};

const makeRunner = (script) => {
  const runner = new bondage.Runner();
  runner.load(script);
  return runner;
};

const summarize = (value) => {
  if (value instanceof bondage.TextResult) return { text: value.text };
  if (value instanceof bondage.OptionsResult) {
    return { options: value.options.map((o) => { return o.text; }) };
  }
  return { command: value.text || value.command };
};

/**
 * Plays a script to the end, taking the given option numbers in turn (then 0).
 * Records, for every result: what was seen, the saved position, a copy of the
 * variables, and the option taken.
 */
const record = (script, choices, startNode = 'Start') => {
  const runner = makeRunner(script);
  const gen = runner.run(startNode);
  const steps = [];
  let picked = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const { value, done } = gen.next();
    if (done) break;
    const step = {
      seen: summarize(value),
      position: gen.getPosition(),
      vars: JSON.parse(JSON.stringify(runner.variables.data)),
      choice: null,
    };
    if (value instanceof bondage.OptionsResult) {
      step.choice = picked < choices.length ? choices[picked] : 0;
      picked += 1;
      value.select(step.choice);
    }
    steps.push(step);
  }
  return steps;
};

/** Resumes from a recorded step, taking the same options as the original run */
const replayFrom = (script, steps, i) => {
  const runner = makeRunner(script);
  runner.variables.data = JSON.parse(JSON.stringify(steps[i].vars));
  const gen = runner.run(steps[i].position);
  const replayed = [];
  for (let j = i; j < steps.length; j += 1) {
    const { value, done } = gen.next();
    expect(done).toBeFalsy();
    replayed.push({ seen: summarize(value), position: gen.getPosition() });
    if (value instanceof bondage.OptionsResult) {
      value.select(steps[j].choice);
    }
  }
  expect(gen.next().done).toBe(true);
  return replayed;
};

describe('Saving and resuming positions', () => {
  describe('round trips', () => {
    const goldValues = [5, 2, 0];
    const choiceSets = [[0, 0, 0], [0, 1, 1], [1, 0], [1, 1], []];

    goldValues.forEach((gold) => {
      choiceSets.forEach((choices) => {
        it(`resuming from every paused line gives the same remainder (gold ${gold}, choices ${JSON.stringify(choices)})`, () => {
          const script = FRESH(gold);
          const steps = record(script, choices);
          const positioned = steps
            .map((step, i) => { return { step, i }; })
            .filter(({ step }) => { return step.position; });
          expect(positioned.length).toBeGreaterThan(3);

          positioned.forEach(({ i }) => {
            const replayed = replayFrom(script, steps, i);
            const expected = steps.slice(i).map((s) => {
              return { seen: s.seen, position: s.position };
            });
            expect(replayed).toEqual(expected);
          });
        });
      });
    });
  });

  describe('getPosition', () => {
    it('describes the path to a line, including a nested option inside an if', () => {
      const runner = makeRunner(FRESH(5));
      const gen = runner.run('Start');
      expect(gen.getPosition()).toBeNull(); // nothing yielded yet
      gen.next(); // Intro
      expect(gen.getPosition()).toEqual({
        node: 'Start',
        gameVersion: 1,
        path: [{ type: 'text', value: 0 }],
      });
      gen.next(); // Rich
      expect(gen.getPosition().path).toEqual([
        { type: 'if', value: 0 },
        { type: 'text', value: 0 },
      ]);
      const options = gen.next().value; // Buy / Leave
      expect(gen.getPosition().path).toEqual([
        { type: 'if', value: 0 },
        { type: 'text', value: 1 },
      ]);
      options.select(0);
      gen.next(); // Bought
      expect(gen.getPosition().path).toEqual([
        { type: 'if', value: 0 },
        { type: 'choice', value: 0 },
        { type: 'text', value: 0 },
      ]);
      const inner = gen.next().value; // Haggle / Pay
      inner.select(1);
      gen.next(); // Paid
      expect(gen.getPosition().path).toEqual([
        { type: 'if', value: 0 },
        { type: 'choice', value: 0 },
        { type: 'choice', value: 1 },
        { type: 'text', value: 0 },
      ]);
    });

    it('passes over finished branches with -1', () => {
      const runner = makeRunner(FRESH(5));
      const gen = runner.run('Start');
      let seen;
      do {
        const { value } = gen.next();
        seen = value;
        if (value instanceof bondage.OptionsResult) value.select(0);
      } while (!(seen instanceof bondage.TextResult && seen.text === 'Between'));
      expect(gen.getPosition().path).toEqual([
        { type: 'if', value: -1 },
        { type: 'text', value: 0 },
      ]);
    });

    it('is null on a command, and once the run is over', () => {
      const runner = makeRunner(FRESH(0));
      const gen = runner.run('Start');
      let seen;
      do {
        seen = gen.next().value;
      } while (!(seen instanceof bondage.CommandResult));
      expect(gen.getPosition()).toBeNull();
      for (let guard = 0; guard < 50; guard += 1) {
        const { value, done } = gen.next();
        if (done) break;
        if (value instanceof bondage.OptionsResult) value.select(0);
      }
      expect(gen.getPosition()).toBeNull();
    });

    it('uses the current gameVersion', () => {
      const runner = makeRunner(FRESH(0));
      runner.gameVersion = 7;
      const gen = runner.run('Start');
      gen.next();
      expect(gen.getPosition().gameVersion).toBe(7);
      expect(Object.keys(gen.getPosition())).toEqual(['node', 'gameVersion', 'path']);
    });

    it('belongs to each generator, so several can run from one runner at once', () => {
      const runner = makeRunner('title: A\n---\nOne\nTwo\nThree\n===');
      const first = runner.run('A');
      const second = runner.run('A');
      expect(first.getPosition()).toBeNull();
      expect(second.getPosition()).toBeNull();

      first.next();
      first.next();
      second.next();
      expect(first.getPosition().path).toEqual([{ type: 'text', value: 1 }]);
      expect(second.getPosition().path).toEqual([{ type: 'text', value: 0 }]);

      // advancing one leaves the other's position alone
      second.next();
      second.next();
      expect(first.getPosition().path).toEqual([{ type: 'text', value: 1 }]);
      expect(second.getPosition().path).toEqual([{ type: 'text', value: 2 }]);

      // a finished generator has no position; the other is unaffected
      second.next();
      expect(second.getPosition()).toBeNull();
      expect(first.getPosition().path).toEqual([{ type: 'text', value: 1 }]);
    });

    it('is no longer a method of the runner', () => {
      expect(makeRunner('title: A\n---\nOne\n===').getPosition).toBeUndefined();
    });

    it('returns a copy that cannot change the generator', () => {
      const runner = makeRunner(FRESH(0));
      const gen = runner.run('Start');
      gen.next();
      gen.getPosition().path.push({ type: 'if', value: 9 });
      expect(gen.getPosition().path).toHaveLength(1);
    });
  });

  describe('run()', () => {
    it('still takes a node name, and runs the node from the very top', () => {
      const runner = makeRunner('title: A\n---\n<<set $a to 5>>\nHello {$a}\n===');
      expect(runner.run('A').next().value.text).toBe('Hello 5');
    });

    it('resuming skips assignments and commands instead of running them', () => {
      const runner = makeRunner('title: A\n---\n<<set $a to 5>>\nHello {$a}\n===');
      const position = { node: 'A', gameVersion: 1, path: [{ type: 'text', value: 0 }] };
      runner.variables.set('a', 99);
      expect(runner.run(position).next().value.text).toBe('Hello 99');
      expect(runner.variables.get('a')).toBe(99);
    });

    it('evaluates nothing while skipping to the position', () => {
      let calls = 0;
      const runner = makeRunner(`title: A
---
<<set $a to bump()>>
<<if bump() > 100>>
  Never
<<endif>>
-> Skipped one {bump()}
  Skipped content
-> Skipped two
  More content
Line {bump()}
<<set $b to bump()>>
Target
===`);
      runner.registerFunction('bump', () => { calls += 1; return 1; });
      const position = {
        node: 'A',
        gameVersion: 1,
        path: [
          { type: 'if', value: -1 },
          { type: 'choice', value: -1 },
          { type: 'text', value: 1 },
        ],
      };
      const gen = runner.run(position);
      expect(calls).toBe(0);
      expect(gen.next().value.text).toBe('Target');
      expect(calls).toBe(0);
      expect(runner.variables.get('a')).toBeUndefined();
      expect(runner.variables.get('b')).toBeUndefined();
    });

    it('does not evaluate the condition or offer the options again when resuming inside them', () => {
      let calls = 0;
      const runner = makeRunner(`title: A
---
<<if bump() == 1>>
  -> Option {bump()}
    Inside
<<endif>>
===`);
      runner.registerFunction('bump', () => { calls += 1; return 1; });
      const position = {
        node: 'A',
        gameVersion: 1,
        path: [
          { type: 'if', value: 0 },
          { type: 'choice', value: 0 },
          { type: 'text', value: 0 },
        ],
      };
      expect(runner.run(position).next().value.text).toBe('Inside');
      expect(calls).toBe(0);
    });

    it('can resume on an option list that has not been answered yet', () => {
      const runner = makeRunner('title: A\n---\nOne\nTwo\n-> Yes\n  Y\n-> No\n  N\nEnd\n===');
      const position = { node: 'A', gameVersion: 1, path: [{ type: 'text', value: 2 }] };
      const value = runner.run(position).next().value;
      expect(summarize(value)).toEqual({ options: ['Yes', 'No'] });
    });

    it('can resume in an else block and after an if that matched nothing', () => {
      const script = `title: A
---
<<set $n to 2>>
<<if $n == 1>>
  One
<<elseif $n == 2>>
  Two
<<else>>
  Many
<<endif>>
<<if $n == 5>>
  Five
<<endif>>
After
===`;
      const inElseif = { node: 'A', gameVersion: 1, path: [{ type: 'if', value: 1 }, { type: 'text', value: 0 }] };
      expect(makeRunner(script).run(inElseif).next().value.text).toBe('Two');
      const inElse = { node: 'A', gameVersion: 1, path: [{ type: 'if', value: 2 }, { type: 'text', value: 0 }] };
      expect(makeRunner(script).run(inElse).next().value.text).toBe('Many');
      const after = {
        node: 'A',
        gameVersion: 1,
        path: [{ type: 'if', value: -1 }, { type: 'if', value: -1 }, { type: 'text', value: 0 }],
      };
      expect(makeRunner(script).run(after).next().value.text).toBe('After');
    });

    it('carries on past the resumed block, including through jumps', () => {
      const runner = makeRunner(FRESH(5));
      const position = {
        node: 'Start',
        gameVersion: 1,
        path: [
          { type: 'if', value: 0 },
          { type: 'choice', value: 1 },
          { type: 'text', value: 0 },
        ],
      };
      const gen = runner.run(position);
      const seen = [];
      for (let guard = 0; guard < 50; guard += 1) {
        const { value, done } = gen.next();
        if (done) break;
        seen.push(summarize(value));
        if (value instanceof bondage.OptionsResult) value.select(0);
      }
      expect(seen.map((s) => { return s.text; }).filter(Boolean)).toEqual([
        'Left', 'Shop done', 'Between', 'Final text', 'Outro', 'Next line', 'Last',
      ]);
    });

    it('ignores entries after the first text entry', () => {
      const runner = makeRunner('title: A\n---\nOne\nTwo\n===');
      const position = {
        node: 'A',
        gameVersion: 1,
        path: [{ type: 'text', value: 1 }, { type: 'if', value: 3 }, { type: 'bogus' }],
      };
      expect(runner.run(position).next().value.text).toBe('Two');
    });
  });

  describe('gameVersion', () => {
    let warn;
    beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });

    it('defaults to 1', () => {
      expect(new bondage.Runner().gameVersion).toBe(1);
    });

    it('warns, but still resumes, when the versions differ', () => {
      const runner = makeRunner('title: A\n---\nOne\nTwo\n===');
      runner.gameVersion = 2;
      const position = { node: 'A', gameVersion: 1, path: [{ type: 'text', value: 1 }] };
      expect(runner.run(position).next().value.text).toBe('Two');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns when run() is called, not on the first next()', () => {
      const runner = makeRunner('title: A\n---\nOne\n===');
      runner.gameVersion = 2;
      runner.run({ node: 'A', gameVersion: 1, path: [{ type: 'text', value: 0 }] });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does not warn when the versions match, or for a plain node name', () => {
      const runner = makeRunner('title: A\n---\nOne\n===');
      runner.gameVersion = 3;
      runner.run('A').next();
      runner.run({ node: 'A', gameVersion: 3, path: [{ type: 'text', value: 0 }] }).next();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('positions that do not fit the script', () => {
    const script = `title: A
---
One
<<if $x>>
  Inside
<<endif>>
-> Opt 1
  Content 1
-> Opt 2
Two
===`;
    const pos = (...path) => { return { node: 'A', gameVersion: 1, path }; };
    const text = (value) => { return { type: 'text', value }; };
    const fails = (position) => {
      const runner = makeRunner(script);
      return () => { runner.run(position).next(); };
    };

    it('throws when the node does not exist', () => {
      const runner = makeRunner(script);
      expect(() => { runner.run({ node: 'Nope', gameVersion: 1, path: [text(0)] }).next(); }).toThrow(/does not exist/);
    });

    it('throws when the branching statement is of the wrong type', () => {
      expect(fails(pos({ type: 'choice', value: 0 }, text(0)))).toThrow(/expected an option list, but found an "if" statement/);
      expect(fails(pos({ type: 'if', value: -1 }, { type: 'if', value: 0 }, text(0)))).toThrow(/expected an "if" statement, but found an option list/);
    });

    it('throws when there is no branching statement of that type left', () => {
      expect(fails(pos({ type: 'if', value: -1 }, { type: 'choice', value: -1 }, { type: 'if', value: 0 }, text(0)))).toThrow(/reached the end of the block/);
    });

    it('throws when the block or option number does not exist', () => {
      expect(fails(pos({ type: 'if', value: 1 }, text(0)))).toThrow(/only has 1/);
      expect(fails(pos({ type: 'if', value: -1 }, { type: 'choice', value: 2 }, text(0)))).toThrow(/only has 2/);
    });

    it('throws when the option to enter has no content', () => {
      expect(fails(pos({ type: 'if', value: -1 }, { type: 'choice', value: 1 }, text(0)))).toThrow(/has no content/);
    });

    it('throws when the text count is too high', () => {
      expect(fails(pos(text(5)))).toThrow(/expected 5 text lines/);
      expect(fails(pos({ type: 'if', value: 0 }, text(3)))).toThrow(/expected 3 text lines/);
    });

    it('throws when a branching statement comes before the counted lines run out', () => {
      expect(fails(pos(text(2)))).toThrow(/"if" statement comes after 1/);
    });

    it('throws when the count leaves nothing to resume at', () => {
      expect(fails(pos({ type: 'if', value: -1 }, { type: 'choice', value: -1 }, text(1)))).toThrow(/nothing after/);
      expect(fails(pos({ type: 'if', value: -1 }, { type: 'choice', value: -1 }, text(2)))).toThrow(/expected 2 text lines/);
    });

    it('throws when the count lands on an if statement', () => {
      expect(fails(pos(text(1)))).toThrow(/expected a text line or option list to resume at, but found an "if" statement/);
    });

    it('throws for malformed positions straight away, from run() itself', () => {
      const runner = makeRunner(script);
      expect(() => { runner.run(null); }).toThrow(/node name or a position/);
      expect(() => { runner.run({ gameVersion: 1, path: [text(0)] }); }).toThrow(/"node"/);
      expect(() => { runner.run({ node: 'A', gameVersion: 1 }); }).toThrow(/"path"/);
      expect(() => { runner.run(pos()); }).toThrow(/must end with a "text" entry/);
      expect(() => { runner.run(pos({ type: 'if', value: 0 })); }).toThrow(/must end with a "text" entry/);
      expect(() => { runner.run(pos({ type: 'bogus', value: 0 }, text(0))); }).toThrow(/not a valid/);
      expect(() => { runner.run(pos({ type: 'if', value: 'a' }, text(0))); }).toThrow(/not a valid/);
      expect(() => { runner.run(pos({ type: 'if', value: -2 }, text(0))); }).toThrow(/invalid value/);
      expect(() => { runner.run(pos(text(-1))); }).toThrow(/invalid value/);
    });
  });
});
