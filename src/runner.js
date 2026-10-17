import parser from './parser/parser';
import results from './results';
import DefaultVariableStorage from './default-variable-storage';
import convertYarn from './convert-yarn-to-js';
import types from './parser/nodes';

const nodeTypes = types.types;

// Entry types of a position's path (see the getPosition() of the generator returned by run()).
//  'choice': an option list. value = option entered, or -1 to pass over the list
//  'if':     an if/elseif/else statement. value = block entered (0 = the "if",
//            1 = the next elseif/else, ...), or -1 to pass over the statement
//  'text':   always the last entry. value = number of displayed text lines to
//            pass in the current block before the line (or option list) that
//            was being displayed.
const PATH_CHOICE = 'choice';
const PATH_IF = 'if';
const PATH_TEXT = 'text';

const isTextNode = (node) => {
  return node instanceof nodeTypes.Text || node instanceof nodeTypes.Expression;
};
const isBranching = (node) => {
  return node instanceof nodeTypes.Conditional || node instanceof nodeTypes.Shortcut;
};
const isEndOfFlow = (node) => {
  return node instanceof types.JumpCommandNode || node instanceof types.StopCommandNode;
};
// Text and inline expressions on the same source line make up ONE displayed line.
const continuesTextRun = (node, nextNode) => {
  return !!nextNode && node.lineNum === nextNode.lineNum && isTextNode(nextNode);
};
const describeNode = (node) => {
  if (node instanceof nodeTypes.Conditional) return 'an "if" statement';
  if (node instanceof nodeTypes.Shortcut) return 'an option list';
  if (isTextNode(node)) return 'a text line';
  return 'a statement';
};

class Runner {
  constructor() {
    this.noEscape = false;
    this.yarnNodes = {};
    this.variables = new DefaultVariableStorage();
    this.functions = {};
    this.visited = {};
    // Free for the software using this library to change. It is stored in saved
    // positions, and a warning is logged if run() gets a position saved under a
    // different value.
    this.gameVersion = 1;
    this.registerFunction('visited', (args) => {
      return !!this.visited[args[0]];
    });
  }

  /**
   * Loads the yarn node data into this.nodes
   * @param dialogue {any[]} yarn dialogue as string or array
   */
  load(dialogue) {
    if (!dialogue) {
      throw new Error('No dialogue supplied');
    }
    let nodes;
    if (typeof dialogue === 'string') {
      nodes = convertYarn(dialogue);
    } else {
      nodes = dialogue;
    }

    nodes.forEach((node) => {
      if (!node.title) {
        throw new Error(`Node needs a title: ${JSON.stringify(node)}`);
      } else if (node.title.split('.').length > 1) {
        throw new Error(`Node title cannot contain a dot: ${node.title}`);
      }
      if (!node.body) {
        throw new Error(`Node needs a body: ${JSON.stringify(node)}`);
      }
      if (this.yarnNodes[node.title]) {
        throw new Error(`Duplicate node title: ${node.title}`);
      }
      this.yarnNodes[node.title] = node;
    });

    parser.yy.areDeclarationsHandled = false;
    parser.yy.declarations = {};
    this.handleDeclarations(nodes);
    parser.yy.areDeclarationsHandled = true;
  }

  /**
   * Set a new variable storage object
   * This must simply contain a 'get(name)' and 'set(name, value)' function
   *
   * Calling this function will clear any existing variable's values
   */
  setVariableStorage(storage) {
    if (typeof storage.set !== 'function' || typeof storage.get !== 'function') {
      throw new Error('Variable Storage object must contain both a "set" and "get" function');
    }

    this.variables = storage;
  }

  /**
   * Scans for <<declare>> commands and sets initial variable values
   * @param {any[]} yarn dialogue as string or array
   */
  handleDeclarations(nodes) {
    const exampleValues = {
      Number: 0,
      String: '',
      Boolean: false,
    };

    const allLines = nodes.reduce((acc, node) => {
      const nodeLines = node.body.split(/\r?\n+/);
      return [...acc, ...nodeLines];
    }, []);

    const declareLines = allLines.reduce((acc, line) => {
      const match = line.match(/^<<declare .+>>/);
      return match
        ? [...acc, line]
        : acc;
    }, []);
    if (declareLines.length) {
      parser.parse(declareLines.join('\n'));
    }

    Object.entries(parser.yy.declarations)
      .forEach(([variableName, { expression, explicitType }]) => {
        const value = this.evaluateExpressionOrLiteral(expression);

        if (explicitType && typeof value !== typeof exampleValues[explicitType]) {
          throw new Error(`Cannot declare value ${value} as type ${explicitType} for variable ${variableName}`);
        }

        if (!this.variables.get(variableName)) {
          this.variables.set(variableName, value);
        }
      });
  }

  registerFunction(name, func) {
    if (typeof func !== 'function') {
      throw new Error('Registered function must be...well...a function');
    }

    this.functions[name] = func;
  }

  /**
   * Generator to return each sequential dialog result.
   *
   * Takes either the name of a yarn node to start at, or a position object
   * (see getPosition(), below) to resume from exactly where that position was
   * saved.
   * Resuming executes, evaluates and yields NOTHING until it reaches the saved
   * position: variables, functions etc. are left exactly as they are. The
   * saved line (or option list) is then yielded again as the first result.
   *
   * The returned generator has a getPosition() method of its own, so any
   * number of generators can run at once, each knowing where it is.
   * (Variables and functions are shared by all generators of this runner.)
   *
   * A malformed position object throws immediately. A position that doesn't
   * match the loaded script (the script changed since the save) throws on the
   * first next().
   *
   * @param {string|object} startPosition - A node name, or a position object
   *   of the form { node, gameVersion, path }
   */
  run(startPosition) {
    const position = this.normalizePosition(startPosition);
    // Each generator tracks its own position
    const tracker = { position: null };
    const generator = this.runFromPosition(position, tracker);

    /**
     * Describes where this generator is, so that run() can come back to it
     * later. Only meaningful while the generator is paused on a text line or
     * an option list. Returns null otherwise (before the first result, while
     * paused on a command, or once the generator is finished).
     *
     * Returns { node, gameVersion, path } where path is an array of
     * { type, value } entries, one for every if-statement and option list that
     * comes before the paused line in its node, in order:
     *   { type: 'choice', value: n }  enter option n of the option list
     *   { type: 'if', value: n }      enter block n (0 = "if", 1 = next "elseif"/"else")
     *   { type: 'choice' | 'if', value: -1 }   pass over the statement
     *   { type: 'text', value: n }    always last: pass n displayed text lines,
     *                                 then the paused line (or option list) is next
     */
    generator.getPosition = () => {
      if (!tracker.position) {
        return null;
      }
      return {
        node: tracker.position.node,
        gameVersion: this.gameVersion,
        path: tracker.position.path.map((entry) => { return { ...entry }; }),
      };
    };

    return generator;
  }

  * runFromPosition({ node: startNode, path, isFreshStart }, tracker) {
    let jumpTo = startNode;
    // Only the first node is resumed mid-way. Jumps start nodes afresh
    let resume = isFreshStart ? null : path;
    tracker.position = null;
    while (jumpTo) {
      const yarnNode = this.yarnNodes[jumpTo];
      if (yarnNode === undefined) {
        throw new Error(`Node "${startNode}" does not exist`);
      }

      this.visited[startNode] = true;

      // Parse the entire node
      const parserNodes = Array.from(parser.parse(yarnNode.body));
      const metadata = { ...yarnNode };
      delete metadata.body;
      const result = yield* this.evalNodes(parserNodes, metadata, [], resume, tracker);
      resume = null;
      jumpTo = result && result.jump;
    }
    tracker.position = null;
  }

  /**
   * Turns the argument of run() into a validated position object.
   * A plain node name means "start that node from the top", which is NOT the
   * same as resuming at { type: 'text', value: 0 }: a resume skips any commands
   * and assignments ahead of the first line, a fresh start runs them.
   */
  normalizePosition(input) {
    if (typeof input === 'string') {
      return {
        node: input,
        gameVersion: this.gameVersion,
        path: [{ type: PATH_TEXT, value: 0 }],
        isFreshStart: true,
      };
    }

    if (!input || typeof input !== 'object') {
      throw new Error('run() needs a node name or a position object');
    }
    if (typeof input.node !== 'string' || !input.node) {
      throw new Error('Position needs a "node" name');
    }
    if (!Array.isArray(input.path)) {
      throw new Error('Position needs a "path" array');
    }
    if (input.gameVersion !== this.gameVersion) {
      console.warn(`Resuming a position saved under gameVersion ${input.gameVersion}, but this runner's gameVersion is ${this.gameVersion}. The script may have changed since the position was saved.`); // eslint-disable-line no-console
    }

    // Everything after the first 'text' entry is ignored
    const path = [];
    for (let i = 0; i < input.path.length; i += 1) {
      const entry = input.path[i];
      const isValidType = entry && [PATH_CHOICE, PATH_IF, PATH_TEXT].includes(entry.type);
      if (!isValidType || !Number.isInteger(entry.value)) {
        throw new Error(`Position path entry ${i} is not a valid { type, value }: ${JSON.stringify(entry)}`);
      }
      if (entry.value < (entry.type === PATH_TEXT ? 0 : -1)) {
        throw new Error(`Position path entry ${i} has an invalid value: ${JSON.stringify(entry)}`);
      }
      path.push({ type: entry.type, value: entry.value });
      if (entry.type === PATH_TEXT) {
        break;
      }
    }
    if (!path.length || path[path.length - 1].type !== PATH_TEXT) {
      throw new Error(`Position path must end with a "${PATH_TEXT}" entry`);
    }

    return {
      node: input.node,
      gameVersion: input.gameVersion,
      path,
      isFreshStart: false,
    };
  }

  /**
   * Walks the statements of one block to the spot described by the first
   * entries of "resume". Nothing is executed, evaluated or yielded on the way.
   * Throws if the statements don't match the path.
   *
   * Returns {
   *   index:   where to carry on from in this block,
   *   entered: null, or { index, value } the branching statement to enter
   *            instead of executing it (value = block / option number),
   *   rest:    the path entries still to be followed inside what was entered,
   *   passed:  the 'pass over' entries consumed in this block,
   *   lines:   displayed lines already passed in this block since the last
   *            branching statement,
   * }
   */
  seekPosition(nodes, resume, metadata) {
    const fail = (reason) => {
      throw new Error(`Cannot restore position in node "${metadata.title}": ${reason}. Has the script changed since it was saved?`);
    };
    const passed = [];
    let idx = 0;

    for (let e = 0; e < resume.length; e += 1) {
      const entry = resume[e];

      if (entry.type === PATH_TEXT) {
        // Pass entry.value displayed lines (and any non-displayed statements)
        let remaining = entry.value;
        for (;;) {
          while (idx < nodes.length && !isTextNode(nodes[idx]) && !isBranching(nodes[idx])) {
            if (isEndOfFlow(nodes[idx])) {
              fail('a jump or stop command comes before the saved line');
            }
            idx += 1;
          }
          if (remaining === 0) {
            break;
          }
          if (idx >= nodes.length) {
            fail(`expected ${entry.value} text lines before the saved line, but only found ${entry.value - remaining}`);
          }
          if (isBranching(nodes[idx])) {
            fail(`expected ${entry.value} text lines before the saved line, but ${describeNode(nodes[idx])} comes after ${entry.value - remaining}`);
          }
          let runEnd = idx;
          while (continuesTextRun(nodes[runEnd], nodes[runEnd + 1])) {
            runEnd += 1;
          }
          idx = runEnd + 1;
          remaining -= 1;
        }
        if (idx >= nodes.length) {
          fail(`there is nothing after the ${entry.value} text lines to resume at`);
        }
        if (nodes[idx] instanceof nodeTypes.Conditional) {
          fail('expected a text line or option list to resume at, but found an "if" statement');
        }
        return { index: idx, entered: null, rest: [], passed, lines: entry.value };
      }

      // Branching entry: everything up to the next branching statement is skipped
      let found = idx;
      while (found < nodes.length && !isBranching(nodes[found])) {
        if (isEndOfFlow(nodes[found])) {
          fail('a jump or stop command comes before the saved position');
        }
        found += 1;
      }
      if (found >= nodes.length) {
        fail(`expected ${entry.type === PATH_IF ? 'an "if" statement' : 'an option list'}, but reached the end of the block`);
      }

      const node = nodes[found];
      const isIf = node instanceof nodeTypes.Conditional;
      if ((entry.type === PATH_IF) !== isIf) {
        fail(`expected ${entry.type === PATH_IF ? 'an "if" statement' : 'an option list'}, but found ${describeNode(node)}`);
      }

      let end = found;
      let size;
      if (isIf) {
        size = this.getConditionalBlocks(node).length;
      } else {
        while (nodes[end + 1] instanceof nodeTypes.Shortcut) {
          end += 1;
        }
        size = end - found + 1;
      }

      if (entry.value === -1) {
        passed.push({ type: entry.type, value: -1 });
        idx = end + 1;
      } else {
        if (entry.value >= size) {
          fail(`expected ${isIf ? 'block' : 'option'} ${entry.value}, but the ${isIf ? '"if" statement only has' : 'option list only has'} ${size}`);
        }
        if (!isIf && !nodes[found + entry.value].content) {
          fail(`option ${entry.value} has no content to resume inside`);
        }
        return {
          index: found,
          entered: { index: found, value: entry.value },
          rest: resume.slice(e + 1),
          passed,
          lines: 0,
        };
      }
    }

    // Unreachable: normalizePosition() guarantees a final 'text' entry
    return fail('the path has no final "text" entry');
  }

  /**
   * Evaluate a list of parser nodes, yielding the ones that need to be seen by
   * the user. Calls itself recursively if that is required by nested nodes
   * @param {Node[]} nodes
   * @param {YarnNode[]} metadata
   * @param {object[]} path - position path entries leading to this block
   * @param {object[]} [resume] - position path entries to resume from in this block
   * @param {object} [tracker] - receives the position of the generator as it yields
   */
  * evalNodes(nodes, metadata, path = [], resume = null, tracker = { position: null }) {
    let textRun = '';

    const filteredNodes = nodes.filter(Boolean);

    // Position bookkeeping: the branching statements already passed in this
    // block, and the displayed lines passed since the last one
    const levelPath = [];
    let linesSinceBranch = 0;

    let nodeIdx = 0;
    let entered = null;
    if (resume && resume.length) {
      const seek = this.seekPosition(filteredNodes, resume, metadata);
      nodeIdx = seek.index;
      entered = seek.entered && { ...seek.entered, rest: seek.rest };
      levelPath.push(...seek.passed);
      linesSinceBranch = seek.lines;
    }

    // Yield the individual user-visible results
    // Need to accumulate all adjacent selectables
    // into one list (hence some of the weirdness here)
    for (; nodeIdx < filteredNodes.length; nodeIdx += 1) {
      const node = filteredNodes[nodeIdx];
      const nextNode = filteredNodes[nodeIdx + 1];

      // Text and the output of Inline Expressions
      // are combined to deliver a TextNode.
      if (isTextNode(node)) {
        textRun += this.evaluateExpressionOrLiteral(node).toString();
        if (continuesTextRun(node, nextNode)) {
          // Same line, with another text equivalent to add to the
          // text run further on in the loop, so don't yield.
        } else {
          tracker.position = {
            node: metadata.title,
            path: [...path, ...levelPath, { type: PATH_TEXT, value: linesSinceBranch }],
          };
          yield new results.TextResult(textRun, node.hashtags, metadata);
          linesSinceBranch += 1;
          textRun = '';
        }
      } else if (node instanceof nodeTypes.Shortcut) {
        // Accumulate the whole series of shortcuts
        let groupEnd = nodeIdx;
        while (filteredNodes[groupEnd + 1] instanceof nodeTypes.Shortcut) {
          groupEnd += 1;
        }
        const shortcutNodes = filteredNodes.slice(nodeIdx, groupEnd + 1);
        const basePath = [...path, ...levelPath];

        let result;
        if (entered && entered.index === nodeIdx) {
          // Resuming inside an option: the options aren't offered again and
          // nothing about them is evaluated
          const optionPath = [...basePath, { type: PATH_CHOICE, value: entered.value }];
          result = yield* this.evalNodes(
            shortcutNodes[entered.value].content,
            metadata,
            optionPath,
            entered.rest,
            tracker,
          );
          entered = null;
        } else {
          result = yield* this.handleShortcuts(
            shortcutNodes,
            metadata,
            basePath,
            linesSinceBranch,
            tracker,
          );
        }
        if (result && (result.stop || result.jump)) {
          return result;
        }
        levelPath.push({ type: PATH_CHOICE, value: -1 });
        linesSinceBranch = 0;
        nodeIdx = groupEnd;
      } else if (node instanceof nodeTypes.Assignment) {
        this.evaluateAssignment(node);
      } else if (node instanceof nodeTypes.Conditional) {
        let chosen;
        let chosenResume = null;
        if (entered && entered.index === nodeIdx) {
          // Resuming inside a block: the condition isn't evaluated again
          chosen = {
            index: entered.value,
            statements: this.getConditionalBlocks(node)[entered.value],
          };
          chosenResume = entered.rest;
          entered = null;
        } else {
          // Get the results of the conditional
          chosen = this.evaluateConditionalBlock(node);
        }
        if (chosen) {
          // Run the remaining results
          const result = yield* this.evalNodes(
            chosen.statements,
            metadata,
            [...path, ...levelPath, { type: PATH_IF, value: chosen.index }],
            chosenResume,
            tracker,
          );
          if (result && (result.stop || result.jump)) {
            return result;
          }
        }
        levelPath.push({ type: PATH_IF, value: -1 });
        linesSinceBranch = 0;
      } else if (node instanceof types.JumpCommandNode) {
        // ignore the rest of this outer loop and
        // tell parent loops to ignore following nodes.
        // Recursive call here would cause stack overflow
        return { jump: node.destination };
      } else if (node instanceof types.StopCommandNode) {
        // ignore the rest of this outer loop and
        // tell parent loops to ignore following nodes
        return { stop: true };
      } else {
        const command = this.evaluateExpressionOrLiteral(node.command);
        // A position can't be saved while paused on a command
        tracker.position = null;
        yield new results.CommandResult(command, node.hashtags, metadata);
      }
    }

    return undefined;
  }

  /**
   * yield a shortcut result then handle the subsequent selection
   * @param {any[]} selections
   * @param {YarnNode[]} metadata
   * @param {object[]} basePath - position path entries leading to this option list
   * @param {number} lines - displayed lines passed since the last branching
   *   statement in the current block
   * @param {object} [tracker] - receives the position of the generator as it yields
   */
  * handleShortcuts(selections, metadata, basePath = [], lines = 0, tracker = { position: null }) {
    // Multiple options to choose from (or just a single shortcut)
    // Tag any conditional dialog options that result to false,
    // the consuming app does the actual filtering or whatever
    const transformedSelections = selections.map((s) => {
      let isAvailable = true;

      if (
        s.conditionalExpression
        && !this.evaluateExpressionOrLiteral(s.conditionalExpression)
      ) {
        isAvailable = false;
      }

      const text = this.evaluateExpressionOrLiteral(s.text);
      return Object.assign(s, { isAvailable, text });
    });

    const optionsResult = new results.OptionsResult(transformedSelections, metadata);
    tracker.position = {
      node: metadata.title,
      path: [...basePath, { type: PATH_TEXT, value: lines }],
    };
    yield optionsResult;
    if (typeof optionsResult.selected === 'number') {
      const selectedOption = transformedSelections[optionsResult.selected];
      if (selectedOption.content) {
        // Recursively go through the nodes nested within
        return yield* this.evalNodes(
          selectedOption.content,
          metadata,
          [...basePath, { type: PATH_CHOICE, value: optionsResult.selected }],
          null,
          tracker,
        );
      }
    } else {
      throw new Error('No option selected before resuming dialogue');
    }

    return undefined;
  }

  /**
   * Evaluates the given assignment node
   */
  evaluateAssignment(node) {
    const result = this.evaluateExpressionOrLiteral(node.expression);
    const oldValue = this.variables.get(node.variableName);
    if (oldValue && typeof oldValue !== typeof result) {
      throw new Error(`Variable ${node.variableName} is already type ${typeof oldValue}; cannot set equal to ${result} of type ${typeof result}`);
    }
    this.variables.set(node.variableName, result);
  }

  /**
   * Evaluates the given conditional node
   * Returns the statements to be run as a result of it (if any)
   */
  evaluateConditional(node) {
    const block = this.evaluateConditionalBlock(node);
    return block ? block.statements : null;
  }

  /**
   * Evaluates the given conditional node
   * Returns the block to be run as a result of it, as { index, statements },
   * or null if no block is to be run. "index" is the block's number within the
   * statement: 0 for the "if" block, 1 for the next "elseif"/"else", and so on
   */
  evaluateConditionalBlock(node, index = 0) {
    if (node.type === 'IfNode') {
      if (this.evaluateExpressionOrLiteral(node.expression)) {
        return { index, statements: node.statement };
      }
    } else if (node.type === 'IfElseNode' || node.type === 'ElseIfNode') {
      if (this.evaluateExpressionOrLiteral(node.expression)) {
        return { index, statements: node.statement };
      }

      if (node.elseStatement) {
        return this.evaluateConditionalBlock(node.elseStatement, index + 1);
      }
    } else {
      // ElseNode
      return { index, statements: node.statement };
    }

    return null;
  }

  /**
   * Returns the statements of every block of the given conditional node, in
   * order, without evaluating anything
   */
  getConditionalBlocks(node) {
    const blocks = [];
    let current = node;
    while (current) {
      blocks.push(current.statement);
      current = current.elseStatement;
    }
    return blocks;
  }

  evaluateFunctionCall(node) {
    if (this.functions[node.functionName]) {
      return this.functions[node.functionName](
        ...node.args.map(this.evaluateExpressionOrLiteral, this),
      );
    }
    throw new Error(`Function "${node.functionName}" not found`);
  }

  /**
   * Evaluates an expression or literal down to its final value
   */
  evaluateExpressionOrLiteral(node) {
    // A combined array of text and inline expressions to be treated as one.
    // Could probably be cleaned up by introducing a new node type.
    if (Array.isArray(node)) {
      return node.reduce((acc, n) => {
        return acc + this.evaluateExpressionOrLiteral(n).toString();
      }, '');
    }

    const nodeHandlers = {
      UnaryMinusExpressionNode: (a) => { return -a; },
      ArithmeticExpressionAddNode: (a, b) => { return a + b; },
      ArithmeticExpressionMinusNode: (a, b) => { return a - b; },
      ArithmeticExpressionExponentNode: (a, b) => { return a ** b; },
      ArithmeticExpressionMultiplyNode: (a, b) => { return a * b; },
      ArithmeticExpressionDivideNode: (a, b) => { return a / b; },
      ArithmeticExpressionModuloNode: (a, b) => { return a % b; },
      NegatedBooleanExpressionNode: (a) => { return !a; },
      BooleanOrExpressionNode: (a, b) => { return a || b; },
      BooleanAndExpressionNode: (a, b) => { return a && b; },
      BooleanXorExpressionNode: (a, b) => { return !!(a ^ b); }, // eslint-disable-line no-bitwise
      EqualToExpressionNode: (a, b) => { return a === b; },
      NotEqualToExpressionNode: (a, b) => { return a !== b; },
      GreaterThanExpressionNode: (a, b) => { return a > b; },
      GreaterThanOrEqualToExpressionNode: (a, b) => { return a >= b; },
      LessThanExpressionNode: (a, b) => { return a < b; },
      LessThanOrEqualToExpressionNode: (a, b) => { return a <= b; },
      TextNode: (a) => { return a.text; },
      EscapedCharacterNode: (a) => { return this.noEscape ? a.text : a.text.slice(1); },
      NumericLiteralNode: (a) => { return parseFloat(a.numericLiteral); },
      StringLiteralNode: (a) => { return `${a.stringLiteral}`; },
      BooleanLiteralNode: (a) => { return a.booleanLiteral === 'true'; },
      VariableNode: (a) => { return this.variables.get(a.variableName); },
      FunctionCallNode: (a) => { return this.evaluateFunctionCall(a); },
      InlineExpressionNode: (a) => { return a; },
    };

    const handler = nodeHandlers[node.type];
    if (!handler) {
      throw new Error(`node type not recognized: ${node.type}`);
    }

    return handler(
      node instanceof nodeTypes.Expression
        ? this.evaluateExpressionOrLiteral(node.expression || node.expression1)
        : node,
      node.expression2
        ? this.evaluateExpressionOrLiteral(node.expression2)
        : node,
    );
  }
}

export default {
  Runner,
  TextResult: results.TextResult,
  CommandResult: results.CommandResult,
  OptionsResult: results.OptionsResult,
};
