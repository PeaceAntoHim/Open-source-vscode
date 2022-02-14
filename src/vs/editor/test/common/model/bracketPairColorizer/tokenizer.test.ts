/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert = require('assert');
import { DisposableStore } from 'vs/base/common/lifecycle';
import { TokenizationResult2 } from 'vs/editor/common/core/token';
import { LanguageAgnosticBracketTokens } from 'vs/editor/common/model/bracketPairColorizer/brackets';
import { Length, lengthAdd, lengthsToRange, lengthZero } from 'vs/editor/common/model/bracketPairColorizer/length';
import { SmallImmutableSet, DenseKeyProvider } from 'vs/editor/common/model/bracketPairColorizer/smallImmutableSet';
import { TextBufferTokenizer, Token, Tokenizer, TokenKind } from 'vs/editor/common/model/bracketPairColorizer/tokenizer';
import { TextModel } from 'vs/editor/common/model/textModel';
import { IState, ITokenizationSupport, LanguageId, LanguageIdentifier, MetadataConsts, StandardTokenType, TokenizationRegistry } from 'vs/editor/common/modes';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { createTextModel } from 'vs/editor/test/common/editorTestUtils';

suite('Bracket Pair Colorizer - Tokenizer', () => {
	test('Basic', () => {
		const languageId = 2;
		const mode1 = new LanguageIdentifier('testMode1', languageId);
		const denseKeyProvider = new DenseKeyProvider<string>();
		const getImmutableSet = (elements: string[]) => {
			let newSet = SmallImmutableSet.getEmpty();
			elements.forEach(x => newSet = newSet.add(`${languageId}:::${x}`, denseKeyProvider));
			return newSet;
		};
		const getKey = (value: string) => {
			return denseKeyProvider.getKey(`${languageId}:::${value}`);
		};

		const tStandard = (text: string) => new TokenInfo(text, mode1.id, StandardTokenType.Other);
		const tComment = (text: string) => new TokenInfo(text, mode1.id, StandardTokenType.Comment);
		const document = new TokenizedDocument([
			tStandard(' { } '), tStandard('be'), tStandard('gin end'), tStandard('\n'),
			tStandard('hello'), tComment('{'), tStandard('}'),
		]);

		const disposableStore = new DisposableStore();
		disposableStore.add(TokenizationRegistry.register(mode1.language, document.getTokenizationSupport()));
		disposableStore.add(LanguageConfigurationRegistry.register(mode1, {
			brackets: [['{', '}'], ['[', ']'], ['(', ')'], ['begin', 'end']],
		}));

		const brackets = new LanguageAgnosticBracketTokens(denseKeyProvider);

		const model = createTextModel(document.getText(), {}, mode1);
		model.forceTokenization(model.getLineCount());

		const tokens = readAllTokens(new TextBufferTokenizer(model, brackets));

		assert.deepStrictEqual(toArr(tokens, model), [
			{ bracketId: -1, bracketIds: getImmutableSet([]), kind: 'Text', text: ' ', },
			{ bracketId: getKey('{'), bracketIds: getImmutableSet(['{']), kind: 'OpeningBracket', text: '{', },
			{ bracketId: -1, bracketIds: getImmutableSet([]), kind: 'Text', text: ' ', },
			{ bracketId: getKey('{'), bracketIds: getImmutableSet(['{']), kind: 'ClosingBracket', text: '}', },
			{ bracketId: -1, bracketIds: getImmutableSet([]), kind: 'Text', text: ' ', },
			{ bracketId: getKey('begin'), bracketIds: getImmutableSet(['begin']), kind: 'OpeningBracket', text: 'begin', },
			{ bracketId: -1, bracketIds: getImmutableSet([]), kind: 'Text', text: ' ', },
			{ bracketId: getKey('begin'), bracketIds: getImmutableSet(['begin']), kind: 'ClosingBracket', text: 'end', },
			{ bracketId: -1, bracketIds: getImmutableSet([]), kind: 'Text', text: '\nhello{', },
			{ bracketId: getKey('{'), bracketIds: getImmutableSet(['{']), kind: 'ClosingBracket', text: '}', }
		]);

		disposableStore.dispose();
	});
});

function readAllTokens(tokenizer: Tokenizer): Token[] {
	const tokens = new Array<Token>();
	while (true) {
		const token = tokenizer.read();
		if (!token) {
			break;
		}
		tokens.push(token);
	}
	return tokens;
}

function toArr(tokens: Token[], model: TextModel): any[] {
	const result = new Array<any>();
	let offset = lengthZero;
	for (const token of tokens) {
		result.push(tokenToObj(token, offset, model));
		offset = lengthAdd(offset, token.length);
	}
	return result;
}

function tokenToObj(token: Token, offset: Length, model: TextModel): any {
	return {
		text: model.getValueInRange(lengthsToRange(offset, lengthAdd(offset, token.length))),
		bracketId: token.bracketId,
		bracketIds: token.bracketIds,
		kind: {
			[TokenKind.ClosingBracket]: 'ClosingBracket',
			[TokenKind.OpeningBracket]: 'OpeningBracket',
			[TokenKind.Text]: 'Text',
		}[token.kind]
	};
}

class TokenizedDocument {
	private readonly tokensByLine: readonly TokenInfo[][];
	constructor(tokens: TokenInfo[]) {
		const tokensByLine = new Array<TokenInfo[]>();
		let curLine = new Array<TokenInfo>();

		for (const token of tokens) {
			const lines = token.text.split('\n');
			let first = true;
			while (lines.length > 0) {
				if (!first) {
					tokensByLine.push(curLine);
					curLine = new Array<TokenInfo>();
				} else {
					first = false;
				}

				if (lines[0].length > 0) {
					curLine.push(token.withText(lines[0]));
				}
				lines.pop();
			}
		}

		tokensByLine.push(curLine);

		this.tokensByLine = tokensByLine;
	}

	getText() {
		return this.tokensByLine.map(t => t.map(t => t.text).join('')).join('\n');
	}

	getTokenizationSupport(): ITokenizationSupport {
		class State implements IState {
			constructor(public readonly lineNumber: number) { }

			clone(): IState {
				return new State(this.lineNumber);
			}

			equals(other: IState): boolean {
				return this.lineNumber === (other as State).lineNumber;
			}
		}

		return {
			getInitialState: () => new State(0),
			tokenize: () => { throw new Error('Method not implemented.'); },
			tokenize2: (line: string, hasEOL: boolean, state: IState, offsetDelta: number): TokenizationResult2 => {
				const state2 = state as State;
				const tokens = this.tokensByLine[state2.lineNumber];
				const arr = new Array<number>();
				let offset = 0;
				for (const t of tokens) {
					arr.push(offset, t.getMetadata());
					offset += t.text.length;
				}

				return new TokenizationResult2(new Uint32Array(arr), new State(state2.lineNumber + 1));
			}
		};
	}
}

class TokenInfo {
	constructor(public readonly text: string, public readonly languageId: LanguageId, public readonly tokenType: StandardTokenType) { }

	getMetadata(): number {
		return (
			(this.languageId << MetadataConsts.LANGUAGEID_OFFSET)
			| (this.tokenType << MetadataConsts.TOKEN_TYPE_OFFSET)
		) >>> 0;
	}

	withText(text: string): TokenInfo {
		return new TokenInfo(text, this.languageId, this.tokenType);
	}
}
