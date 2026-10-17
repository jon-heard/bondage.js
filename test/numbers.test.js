/* eslint-env jest */

'use strict';

import bondage from '../src/index';
import Lexer from '../src/lexer/lexer';
import parser from '../src/parser/parser';
import nodes from '../src/parser/nodes';

// Numbers used to stop after ONE decimal place: "3.14" was read as "3.1" followed
// by a stray "4", which then failed with "Unexpected 'Number'".
describe('Numbers with several decimal places', () => {
  const numbers = ['0', '7', '314', '3.1', '3.14', '0.001', '123.456789', '-2.75', '-0.125', '10.50'];

  describe('Lexer', () => {
    numbers.forEach((number) => {
      it(`reads ${number} as a single Number token`, () => {
        const lexer = new Lexer();
        lexer.setInput(`<<set $x = ${number}>>`);
        expect(lexer.lex()).toBe('BeginCommand');
        expect(lexer.lex()).toBe('Set');
        expect(lexer.lex()).toBe('Variable');
        expect(lexer.lex()).toBe('EqualToOrAssign');
        expect(lexer.lex()).toBe('Number');
        expect(lexer.yytext).toBe(number);
        expect(lexer.lex()).toBe('EndCommand');
        expect(lexer.lex()).toBe('EndOfInput');
      });
    });

    it('reads several long numbers in one expression', () => {
      const lexer = new Lexer();
      lexer.setInput('<<set $x = 1.25 + 2.5 * 3.14159>>');
      ['BeginCommand', 'Set', 'Variable', 'EqualToOrAssign'].forEach((token) => {
        expect(lexer.lex()).toBe(token);
      });
      const seen = [];
      for (let i = 0; i < 5; i += 1) {
        const token = lexer.lex();
        seen.push(token === 'Number' ? lexer.yytext : token);
      }
      expect(seen).toEqual(['1.25', 'Add', '2.5', 'Multiply', '3.14159']);
    });
  });

  describe('Parser', () => {
    it('can parse an assignment of a number with several decimals', () => {
      const results = parser.parse('<<set $third = 3.14>>');
      expect(results).toEqual([
        new nodes.SetVariableEqualToNode('third', new nodes.NumericLiteralNode('3.14')),
      ]);
    });
  });

  describe('Runner', () => {
    const run = (body) => {
      const runner = new bondage.Runner();
      runner.load(`title: A\n---\n${body}\n===`);
      const gen = runner.run('A');
      const lines = [];
      for (let result = gen.next(); !result.done; result = gen.next()) {
        lines.push(result.value.text);
      }
      return { runner, lines };
    };

    it('stores numbers with one, two and several decimals', () => {
      const { runner } = run('<<set $first = 3.1>>\n<<set $second = 314 / 100>>\n<<set $third = 3.14>>\n<<set $fourth = 2.71828>>');
      expect(runner.variables.get('first')).toBe(3.1);
      expect(runner.variables.get('second')).toBe(3.14);
      expect(runner.variables.get('third')).toBe(3.14);
      expect(runner.variables.get('fourth')).toBe(2.71828);
    });

    it('prints the number with all of its decimals', () => {
      const { lines } = run('<<set $pi = 3.14159>>\nPi is {$pi}');
      expect(lines).toEqual(['Pi is 3.14159']);
    });

    it('does arithmetic with them', () => {
      const { runner } = run('<<set $a = 1.25 + 2.5>>\n<<set $b = 0.125 * 8>>\n<<set $c = -0.5 - 0.25>>');
      expect(runner.variables.get('a')).toBe(3.75);
      expect(runner.variables.get('b')).toBe(1);
      expect(runner.variables.get('c')).toBe(-0.75);
    });

    it('compares them in conditions', () => {
      const { lines } = run('<<set $x = 3.14>>\n<<if $x > 3.139 && $x < 3.141>>\n  close\n<<else>>\n  far\n<<endif>>');
      expect(lines).toEqual(['close']);
    });
  });
});
