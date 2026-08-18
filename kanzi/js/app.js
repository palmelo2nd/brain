import { fetchFile, saveFile } from './modules/github.js';
import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { parseMarkdown, stringifyMarkdown } from './modules/dataModel.js';
import { buildReadingQuiz, buildMeaningQuiz, buildFlashcardDeck, checkAnswer } from './modules/quiz.js';
import { getProgressRow, calcAccuracy, applyAnswer, getWeakKanji, summarizeProgress } from './modules/progress.js';

// data/kanjiMaster.json（漢字の読み・意味・熟語）はユーザーごとに変わらない固定参照データなので、
// コードリポジトリに同梱し、通常のfetchで読み込む（GitHub API・PATは不要）。
// GitHubデータリポジトリには学習進捗（progressData）のみを保存する。
const KANJI_MASTER_PATH = 'data/kanjiMaster.json';

const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'kanzi/data.md';

const state = {
    token: '',
    sha: null,
    kanjiData: [],
    progressData: [],
    currentGrade: 'all',
    reading: { quiz: null, answered: false },
    meaning: { quiz: null, answered: false },
    flashcard: { deck: [], index: 0, flipped: false }
};

// ---------- ユーティリティ ----------

function getScopedKanjiList() {
    if (state.currentGrade === 'all') return state.kanjiData;
    return state.kanjiData.filter(k => String(k['学年']) === String(state.currentGrade));
}

function persistLocal() {
    const md = stringifyMarkdown(state.progressData);
    saveCache(md, state.sha || '');
}

function el(id) {
    return document.getElementById(id);
}

// ---------- 画面切り替え ----------

function switchView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
    el(`view-${viewName}`).classList.add('view--active');
    document.querySelector(`.nav-btn[data-view="${viewName}"]`).classList.add('nav-btn--active');

    if (viewName === 'home') renderHome();
    if (viewName === 'reading') startReadingQuiz();
    if (viewName === 'meaning') startMeaningQuiz();
    if (viewName === 'flashcard') startFlashcardSession();
    if (viewName === 'stats') renderStats();
}

// ---------- ホーム ----------

function renderHome() {
    const scoped  = getScopedKanjiList();
    const summary = summarizeProgress(scoped, state.progressData);
    const gradeLabel = state.currentGrade === 'all' ? 'すべての学年' : `小学${state.currentGrade}年`;

    el('home-summary').innerHTML = `
        <p class="summary-line"><strong>${gradeLabel}</strong>：全${summary.total}字</p>
        <p class="summary-line">学習済み：${summary.attempted}字</p>
        <p class="summary-line">平均正答率：${summary.averageAccuracy !== null ? Math.round(summary.averageAccuracy * 100) + '%' : '－'}</p>
    `;
}

// ---------- 読みクイズ ----------

function startReadingQuiz() {
    const scoped = getScopedKanjiList();
    const quiz = buildReadingQuiz(scoped, state.progressData);
    state.reading = { quiz, answered: false };
    renderReadingQuiz();
}

function renderReadingQuiz() {
    const { quiz } = state.reading;
    el('reading-next-btn').style.display = 'none';
    el('reading-feedback').textContent = '';

    if (!quiz) {
        el('reading-question').innerHTML = '<p>この範囲には出題できる漢字がありません。</p>';
        el('reading-choices').innerHTML = '';
        return;
    }

    el('reading-question').innerHTML = `
        <div class="quiz-kanji">${quiz.kanjiRow['漢字']}</div>
        <p>${quiz.questionText}</p>
    `;
    el('reading-choices').innerHTML = '';
    quiz.choices.forEach(choiceText => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'choice-btn';
        btn.textContent = choiceText;
        btn.addEventListener('click', () => answerReadingQuiz(choiceText));
        el('reading-choices').appendChild(btn);
    });
}

function answerReadingQuiz(choiceText) {
    if (state.reading.answered) return;
    state.reading.answered = true;

    const { quiz } = state.reading;
    const isCorrect = checkAnswer(quiz, choiceText);

    state.progressData = applyAnswer(state.progressData, quiz.kanjiRow['ID'], isCorrect);
    persistLocal();

    document.querySelectorAll('#reading-choices .choice-btn').forEach(btn => {
        btn.disabled = true;
        if (btn.textContent === quiz.correctText) btn.classList.add('choice-btn--correct');
        else if (btn.textContent === choiceText) btn.classList.add('choice-btn--wrong');
    });

    el('reading-feedback').textContent = isCorrect ? '正解！' : `ちがうよ。正解は「${quiz.correctText}」`;
    el('reading-feedback').className = 'quiz-feedback ' + (isCorrect ? 'quiz-feedback--correct' : 'quiz-feedback--wrong');
    el('reading-next-btn').style.display = 'inline-block';
}

// ---------- 意味・熟語クイズ ----------

function startMeaningQuiz() {
    const scoped = getScopedKanjiList();
    const quiz = buildMeaningQuiz(scoped, state.progressData);
    state.meaning = { quiz, answered: false };
    renderMeaningQuiz();
}

function renderMeaningQuiz() {
    const { quiz } = state.meaning;
    el('meaning-next-btn').style.display = 'none';
    el('meaning-feedback').textContent = '';

    if (!quiz) {
        el('meaning-question').innerHTML = '<p>この学年にはまだ意味・熟語データがありません。小学1年、またはすべての学年でお試しください。</p>';
        el('meaning-choices').innerHTML = '';
        return;
    }

    el('meaning-question').innerHTML = `
        <div class="quiz-kanji">${quiz.type === 'jukugo' ? '' : quiz.kanjiRow['漢字']}</div>
        <p>${quiz.questionText}</p>
    `;
    el('meaning-choices').innerHTML = '';
    quiz.choices.forEach(choiceText => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'choice-btn';
        btn.textContent = choiceText;
        btn.addEventListener('click', () => answerMeaningQuiz(choiceText));
        el('meaning-choices').appendChild(btn);
    });
}

function answerMeaningQuiz(choiceText) {
    if (state.meaning.answered) return;
    state.meaning.answered = true;

    const { quiz } = state.meaning;
    const isCorrect = checkAnswer(quiz, choiceText);

    state.progressData = applyAnswer(state.progressData, quiz.kanjiRow['ID'], isCorrect);
    persistLocal();

    document.querySelectorAll('#meaning-choices .choice-btn').forEach(btn => {
        btn.disabled = true;
        if (btn.textContent === quiz.correctText) btn.classList.add('choice-btn--correct');
        else if (btn.textContent === choiceText) btn.classList.add('choice-btn--wrong');
    });

    el('meaning-feedback').textContent = isCorrect ? '正解！' : `ちがうよ。正解は「${quiz.correctText}」`;
    el('meaning-feedback').className = 'quiz-feedback ' + (isCorrect ? 'quiz-feedback--correct' : 'quiz-feedback--wrong');
    el('meaning-next-btn').style.display = 'inline-block';
}

// ---------- フラッシュカード ----------

function startFlashcardSession() {
    const scoped = getScopedKanjiList();
    const deck = buildFlashcardDeck(scoped, state.progressData, 20);
    state.flashcard = { deck, index: 0, flipped: false };
    renderFlashcard();
}

function renderFlashcard() {
    const { deck, index, flipped } = state.flashcard;
    el('flashcard-restart-btn').style.display = 'none';
    el('flashcard-rate-buttons').style.display = 'none';
    el('flashcard-back').style.display = 'none';

    if (deck.length === 0) {
        el('flashcard-progress').textContent = '';
        el('flashcard-front').innerHTML = '<p>この範囲には出題できる漢字がありません。</p>';
        return;
    }

    if (index >= deck.length) {
        el('flashcard-progress').textContent = `${deck.length} / ${deck.length}`;
        el('flashcard-front').innerHTML = '<p>おつかれさま！このセットは終わりです。</p>';
        el('flashcard-back').style.display = 'none';
        el('flashcard-restart-btn').style.display = 'inline-block';
        return;
    }

    const card = deck[index];
    el('flashcard-progress').textContent = `${index + 1} / ${deck.length}`;
    el('flashcard-front').innerHTML = `<div class="quiz-kanji">${card['漢字']}</div>`;

    if (flipped) {
        const onyomi = card['音読み']?.length ? `音：${card['音読み'].join('、')}` : '';
        const kunyomi = card['訓読み']?.length ? `訓：${card['訓読み'].join('、')}` : '';
        const imi = card['意味'] ? `<p class="flashcard-imi">${card['意味']}</p>` : '';
        el('flashcard-back').innerHTML = `<p>${onyomi}</p><p>${kunyomi}</p>${imi}`;
        el('flashcard-back').style.display = 'block';
        el('flashcard-rate-buttons').style.display = 'flex';
    }
}

function flipFlashcard() {
    if (state.flashcard.index >= state.flashcard.deck.length) return;
    state.flashcard.flipped = true;
    renderFlashcard();
}

function rateFlashcard(known) {
    const { deck, index } = state.flashcard;
    const card = deck[index];
    state.progressData = applyAnswer(state.progressData, card['ID'], known);
    persistLocal();

    state.flashcard.index += 1;
    state.flashcard.flipped = false;
    renderFlashcard();
}

// ---------- 成績 ----------

function renderStats() {
    const scoped  = getScopedKanjiList();
    const summary = summarizeProgress(scoped, state.progressData);
    const weak    = getWeakKanji(scoped, state.progressData).slice(0, 20);

    el('stats-summary').innerHTML = `
        <p class="summary-line">対象：${summary.total}字／学習済み：${summary.attempted}字</p>
        <p class="summary-line">平均正答率：${summary.averageAccuracy !== null ? Math.round(summary.averageAccuracy * 100) + '%' : '－'}</p>
    `;

    el('stats-weak-list').innerHTML = '';
    if (weak.length === 0) {
        el('stats-weak-list').innerHTML = '<li>まだ苦手な漢字はありません（出題数が少ないか、正答率が良好です）。</li>';
        return;
    }
    weak.forEach(({ kanjiRow, accuracy, attempts }) => {
        const li = document.createElement('li');
        li.textContent = `${kanjiRow['漢字']}（${Math.round(accuracy * 100)}% ・ ${attempts}回出題）`;
        el('stats-weak-list').appendChild(li);
    });
}

// ---------- 設定・データ読込／保存 ----------

async function loadKanjiMaster() {
    const res = await fetch(KANJI_MASTER_PATH);
    if (!res.ok) throw new Error(`kanjiMaster.json 読込失敗 (${res.status})`);
    state.kanjiData = await res.json();
}

async function loadProgressData() {
    const cache = loadCache();
    if (cache) {
        const parsed = parseMarkdown(cache.content);
        state.progressData = parsed.progressData;
        state.sha = cache.sha || null;
    }

    if (!state.token) return;

    try {
        const { content, sha } = await fetchFile(state.token, OWNER, REPO, PATH);
        const parsed = parseMarkdown(content);
        state.progressData = parsed.progressData;
        state.sha = sha;
        saveCache(content, sha);
        setStatus('GitHubから進捗を読み込みました。');
    } catch (err) {
        setStatus(`GitHubからの読込に失敗しました（オフラインのキャッシュを表示中）：${err.message}`);
    }
}

async function handleLoadClick() {
    state.token = el('settings-token-input').value.trim();
    if (state.token) saveToken(state.token);
    setStatus('読み込み中…');
    await loadProgressData();
    switchView('home');
}

async function handleSaveClick() {
    state.token = el('settings-token-input').value.trim();
    if (!state.token) {
        setStatus('保存にはGitHub Personal Access Tokenが必要です。');
        return;
    }
    saveToken(state.token);

    const md = stringifyMarkdown(state.progressData);
    saveCache(md, state.sha || '');

    try {
        setStatus('保存中…');
        const { newSha } = await saveFile(state.token, OWNER, REPO, PATH, md, state.sha);
        state.sha = newSha;
        saveCache(md, newSha);
        setStatus('GitHubへ保存しました。');
    } catch (err) {
        if (err.status === 409) {
            setStatus('他の端末で更新されています。設定タブの「読み込み」で最新化してから、もう一度保存してください。');
        } else {
            setStatus(`保存に失敗しました（進捗はこの端末には保存済みです）：${err.message}`);
        }
    }
}

function setStatus(text) {
    el('settings-status').textContent = text;
}

// ---------- 初期化 ----------

function bindEvents() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    el('grade-select').addEventListener('change', (e) => {
        state.currentGrade = e.target.value;
        const activeView = document.querySelector('.nav-btn--active').dataset.view;
        switchView(activeView);
    });

    el('reading-next-btn').addEventListener('click', startReadingQuiz);
    el('meaning-next-btn').addEventListener('click', startMeaningQuiz);

    el('flashcard-card').addEventListener('click', flipFlashcard);
    el('flashcard-again-btn').addEventListener('click', () => rateFlashcard(false));
    el('flashcard-known-btn').addEventListener('click', () => rateFlashcard(true));
    el('flashcard-restart-btn').addEventListener('click', startFlashcardSession);

    el('settings-load-btn').addEventListener('click', handleLoadClick);
    el('settings-save-btn').addEventListener('click', handleSaveClick);
}

async function init() {
    bindEvents();

    state.token = loadToken() || '';
    if (state.token) el('settings-token-input').value = state.token;

    try {
        await loadKanjiMaster();
    } catch (err) {
        setStatus(`漢字データの読込に失敗しました：${err.message}`);
        return;
    }

    await loadProgressData();
    renderHome();
}

init();
