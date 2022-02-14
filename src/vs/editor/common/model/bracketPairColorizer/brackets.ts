/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { escapeRegExpCharacters } from 'vs/base/common/strings';
import { toLength } from 'vs/editor/common/model/bracketPairColorizer/length';
import { SmallImmutableSet, DenseKeyProvider, identityKeyProvider } from 'vs/editor/common/model/bracketPairColorizer/smallImmutableSet';
import { LanguageId } from 'vs/editor/common/modes';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { BracketAstNode } from './ast';
import { OpeningBracketId, Token, TokenKind } from './tokenizer';

export class BracketTokens {
	static createFromLanguage(languageId: LanguageId, denseKeyProvider: DenseKeyProvider<string>): BracketTokens {
		function getId(languageId: LanguageId, openingText: string): OpeningBracketId {
			return denseKeyProvider.getKey(`${languageId}:::${openingText}`);
		}

		const brackets = [...(LanguageConfigurationRegistry.getColorizedBracketPairs(languageId))];

		const closingBrackets = new Map</* closingText */ string, { openingBrackets: SmallImmutableSet<OpeningBracketId>, first: OpeningBracketId }>();
		const openingBrackets = new Set</* openingText */ string>();

		for (const [openingText, closingText] of brackets) {
			openingBrackets.add(openingText);

			let info = closingBrackets.get(closingText);
			const openingTextId = getId(languageId, openingText);
			if (!info) {
				info = { openingBrackets: SmallImmutableSet.getEmpty(), first: openingTextId };
				closingBrackets.set(closingText, info);
			}
			info.openingBrackets = info.openingBrackets.add(openingTextId, identityKeyProvider);
		}

		const map = new Map<string, Token>();

		for (const [closingText, info] of closingBrackets) {
			const length = toLength(0, closingText.length);
			map.set(closingText, new Token(
				length,
				TokenKind.ClosingBracket,
				info.first,
				info.openingBrackets,
				BracketAstNode.create(length)
			));
		}

		for (const openingText of openingBrackets) {
			const length = toLength(0, openingText.length);
			const openingTextId = getId(languageId, openingText);
			map.set(openingText, new Token(
				length,
				TokenKind.OpeningBracket,
				openingTextId,
				SmallImmutableSet.getEmpty().add(openingTextId, identityKeyProvider),
				BracketAstNode.create(length)
			));
		}

		return new BracketTokens(map);
	}

	private hasRegExp = false;
	private _regExpGlobal: RegExp | null = null;

	constructor(
		private readonly map: Map<string, Token>
	) { }

	getRegExpStr(): string | null {
		if (this.isEmpty) {
			return null;
		} else {
			const keys = [...this.map.keys()];
			keys.sort();
			keys.reverse();
			return keys.map(k => escapeRegExpCharacters(k)).join('|');
		}
	}

	/**
	 * Returns null if there is no such regexp (because there are no brackets).
	*/
	get regExpGlobal(): RegExp | null {
		if (!this.hasRegExp) {
			const regExpStr = this.getRegExpStr();
			this._regExpGlobal = regExpStr ? new RegExp(regExpStr, 'g') : null;
			this.hasRegExp = true;
		}
		return this._regExpGlobal;
	}

	getToken(value: string): Token | undefined {
		return this.map.get(value);
	}

	get isEmpty(): boolean {
		return this.map.size === 0;
	}
}

export class LanguageAgnosticBracketTokens {
	private readonly languageIdToBracketTokens: Map<LanguageId, BracketTokens> = new Map();

	constructor(private readonly denseKeyProvider: DenseKeyProvider<string>) {
	}

	public didLanguageChange(languageId: LanguageId): boolean {
		const existing = this.languageIdToBracketTokens.get(languageId);
		if (!existing) {
			return false;
		}
		const newRegExpStr = BracketTokens.createFromLanguage(languageId, this.denseKeyProvider).getRegExpStr();
		return existing.getRegExpStr() !== newRegExpStr;
	}

	getSingleLanguageBracketTokens(languageId: LanguageId): BracketTokens {
		let singleLanguageBracketTokens = this.languageIdToBracketTokens.get(languageId);
		if (!singleLanguageBracketTokens) {
			singleLanguageBracketTokens = BracketTokens.createFromLanguage(languageId, this.denseKeyProvider);
			this.languageIdToBracketTokens.set(languageId, singleLanguageBracketTokens);
		}
		return singleLanguageBracketTokens;
	}

	getToken(value: string, languageId: LanguageId): Token | undefined {
		const singleLanguageBracketTokens = this.getSingleLanguageBracketTokens(languageId);
		return singleLanguageBracketTokens.getToken(value);
	}
}
