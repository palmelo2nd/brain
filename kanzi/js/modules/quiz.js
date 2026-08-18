// (1) インポート — progress.js（出題重み付けのため）
import { weightedSample } from './progress.js';

function shuffle(array) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function pickOne(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function buildChoices(correctText, distractorPool, correctExcludeSet) {
    const candidates = shuffle(distractorPool.filter(t => t && !correctExcludeSet.has(t)));
    const uniqueDistractors = [...new Set(candidates)].slice(0, 3);
    return shuffle([correctText, ...uniqueDistractors]);
}

/**
 * 読みクイズを1問作る（漢字を見せて、正しい読みを4択で選ばせる）。
 *
 * (2) インプット: kanjiList — 出題範囲の漢字配列, progressData — 出題重み付け用
 * (3) メイン: 重み付き抽選で対象漢字を1件選び、音読み/訓読みからランダムに正解を決め、
 *             他の漢字の読みから紛らわしくない誤答3件を作る
 * (4) アウトプット: { type:'reading', kanjiRow, questionText, choices, correctText } or null（出題対象が無い場合）
 */
export function buildReadingQuiz(kanjiList, progressData) {
    if (kanjiList.length < 4) return null;

    const [target] = weightedSample(kanjiList, progressData, 1);
    if (!target) return null;

    const kinds = [];
    if (target['音読み']?.length) kinds.push('音読み');
    if (target['訓読み']?.length) kinds.push('訓読み');
    if (kinds.length === 0) return null;
    const kind = pickOne(kinds);

    const correctText = pickOne(target[kind]);
    const ownReadings = new Set([...(target['音読み'] || []), ...(target['訓読み'] || [])]);

    const distractorPool = kanjiList
        .filter(k => k['ID'] !== target['ID'])
        .flatMap(k => k[kind]?.length ? [pickOne(k[kind])] : []);

    const choices = buildChoices(correctText, distractorPool, ownReadings);
    if (choices.length < 2) return null;

    return {
        type: 'reading',
        kanjiRow: target,
        questionText: `「${target['漢字']}」の${kind}はどれ？`,
        choices,
        correctText
    };
}

/**
 * 意味・熟語クイズを1問作る（漢字の意味、または熟語の空欄に合う漢字を4択で選ばせる）。
 *
 * (2) インプット: kanjiList — 出題範囲の漢字配列, progressData — 出題重み付け用
 * (3) メイン: 意味データが入っている漢字だけを対象に、「意味を当てる」「熟語の空欄に合う漢字を当てる」の
 *             いずれかをランダムに選んで出題する
 * (4) アウトプット: { type:'meaning'|'jukugo', kanjiRow, questionText, choices, correctText } or null（意味データが無い場合）
 */
export function buildMeaningQuiz(kanjiList, progressData) {
    const eligible = kanjiList.filter(k => k['意味']);
    if (eligible.length < 4) return null;

    const withJukugo = eligible.filter(k => k['熟語']?.length);
    const useJukugo  = withJukugo.length >= 4 && Math.random() < 0.5;

    const [target] = weightedSample(useJukugo ? withJukugo : eligible, progressData, 1);
    if (!target) return null;

    if (useJukugo) {
        const jukugo = pickOne(target['熟語']);
        const blanked = jukugo['語'].replace(target['漢字'], '＿');
        const distractorPool = eligible
            .filter(k => k['ID'] !== target['ID'])
            .map(k => k['漢字']);
        const choices = buildChoices(target['漢字'], distractorPool, new Set([target['漢字']]));
        if (choices.length < 2) return null;

        return {
            type: 'jukugo',
            kanjiRow: target,
            questionText: `「${blanked}（${jukugo['読み']}）」の＿に入る漢字はどれ？`,
            choices,
            correctText: target['漢字']
        };
    }

    const distractorPool = eligible
        .filter(k => k['ID'] !== target['ID'])
        .map(k => k['意味']);
    const choices = buildChoices(target['意味'], distractorPool, new Set([target['意味']]));
    if (choices.length < 2) return null;

    return {
        type: 'meaning',
        kanjiRow: target,
        questionText: `「${target['漢字']}」の意味はどれ？`,
        choices,
        correctText: target['意味']
    };
}

/**
 * フラッシュカード用のカード束を作る（苦手・未学習な漢字を優先しつつシャッフル）。
 *
 * (2) インプット: kanjiList, progressData, count
 * (3) メイン: 重み付き抽選でcount件を選ぶ
 * (4) アウトプット: 漢字行の配列
 */
export function buildFlashcardDeck(kanjiList, progressData, count) {
    return weightedSample(kanjiList, progressData, Math.min(count, kanjiList.length));
}

/**
 * クイズの選択肢が正解かどうかを判定する。
 *
 * (2) インプット: quiz, chosenText
 * (3) メイン: quiz.correctTextとの一致判定
 * (4) アウトプット: 真偽値
 */
export function checkAnswer(quiz, chosenText) {
    return chosenText === quiz.correctText;
}
