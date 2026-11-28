// 判题与渲染题

let currentQuestionIndex = 0
let currentData = null
let currentQuestionMap = []
let currentQuestionKeys = new Set()

// 乱序设置：localStorage 是同步读取的，避免和 IndexedDB 里的题库加载产生竞态
let shuffleQuestionsEnabled = readLocalFlag('bhu.shuffleQuestions')
let shuffleOptionsEnabled = readLocalFlag('bhu.shuffleOptions')
// 每次载入题库后固定一套乱序，避免切题/重渲染时顺序一直跳
let questionOrderCache = new Map()
let optionOrderCache = new Map()

// 错题统计：内存缓存 + IndexedDB 自动保存（重置做题记录不会清掉统计）
const STATS_RECORD_ID = 'attemptStats'
let attemptStats = null
let statsLoading = null
let statsSaveTimer = null
let statsSelectedChapter = null

function readLocalFlag(key) {
    try {
        return localStorage.getItem(key) === '1'
    } catch (e) {
        return false
    }
}

function writeLocalFlag(key, enabled) {
    try {
        localStorage.setItem(key, enabled ? '1' : '0')
    } catch (e) {
        // 隐私模式或被禁用时忽略，功能仍可在当前页面临时生效
    }
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]))
}

function shuffleArray(list) {
    const arr = list.slice()
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
}

function makeQuestionKey(chapter, type, question) {
    const text = String(question.question || '').replace(/\s+/g, ' ').trim()
    return `${chapter}@@${text}`
}

// 统一题型：题库里的单选/多选在内存中原地合并成「不定项」
function normalizeBank(data) {
    if (!data || typeof data !== 'object') return data
    Object.keys(data).forEach(chapter => {
        const value = data[chapter]
        if (Array.isArray(value)) {
            value.forEach(q => { if (q) q.type = '不定项' })
            data[chapter] = { '不定项': value }
            return
        }
        if (!value || typeof value !== 'object') {
            data[chapter] = { '不定项': [] }
            return
        }
        const onlyKeys = Object.keys(value)
        if (Array.isArray(value['不定项']) && onlyKeys.length === 1) {
            value['不定项'].forEach(q => { if (q) q.type = '不定项' })
            return
        }
        const list = []
        const seen = new Set()
        onlyKeys.forEach(type => {
            const questions = value[type]
            if (!Array.isArray(questions)) return
            questions.forEach(q => {
                if (!q || seen.has(q)) return
                seen.add(q)
                q.type = '不定项'
                list.push(q)
            })
            delete value[type]
        })
        value['不定项'] = list
    })
    return data
}

// 旧统计键是「章节@@题型@@题干」，统一为「章节@@题干」，冲突时合并
function normalizeStatsKeys() {
    if (!attemptStats || !attemptStats.questions) return
    const normalized = {}
    Object.keys(attemptStats.questions).forEach(key => {
        const row = attemptStats.questions[key]
        if (!row) return
        const parts = key.split('@@')
        const newKey = parts.length >= 3 ? `${parts[0]}@@${parts.slice(2).join('@@')}` : key
        row.type = '不定项'
        if (!normalized[newKey]) {
            normalized[newKey] = row
            return
        }
        const target = normalized[newKey]
        target.attempts = (target.attempts || 0) + (row.attempts || 0)
        target.correct = (target.correct || 0) + (row.correct || 0)
        target.wrong = (target.wrong || 0) + (row.wrong || 0)
        target.firstAt = Math.min(target.firstAt || row.firstAt || 0, row.firstAt || target.firstAt || 0)
        target.lastWrongAt = Math.max(target.lastWrongAt || 0, row.lastWrongAt || 0)
        if ((row.lastAt || 0) >= (target.lastAt || 0)) {
            target.lastAt = row.lastAt
            target.lastChosen = row.lastChosen
            target.lastCorrect = row.lastCorrect
        }
        target.wrongAfterCorrect = !!(target.wrongAfterCorrect || row.wrongAfterCorrect)
        target.recent = (target.recent || []).concat(row.recent || [])
            .sort((a, b) => (a.t || 0) - (b.t || 0)).slice(-10)
    })
    attemptStats.questions = normalized
}

function initStats() {
    if (!statsLoading) {
        statsLoading = getStoreData(STATS_RECORD_ID).then(saved => {
            attemptStats = (saved && saved.questions) ? saved : { version: 1, questions: {} }
            normalizeStatsKeys()
            return attemptStats
        }).catch(err => {
            console.error('读取错题统计失败:', err)
            attemptStats = { version: 1, questions: {} }
            return attemptStats
        })
    }
    return statsLoading
}

function scheduleStatsSave() {
    if (statsSaveTimer) clearTimeout(statsSaveTimer)
    statsSaveTimer = setTimeout(() => {
        statsSaveTimer = null
        if (!attemptStats) return
        attemptStats.updatedAt = Date.now()
        saveStoreData(STATS_RECORD_ID, attemptStats).catch(err => {
            console.error('保存错题统计失败:', err)
        })
    }, 400)
}

async function recordAttempt(chapter, type, question, chosen, correct) {
    await initStats()
    const key = makeQuestionKey(chapter, type, question)
    const now = Date.now()
    let entry = attemptStats.questions[key]
    if (!entry) {
        entry = {
            chapter,
            type,
            question: question.question,
            attempts: 0,
            correct: 0,
            wrong: 0,
            firstAt: now,
            lastAt: now,
            lastWrongAt: 0,
            lastChosen: '',
            lastCorrect: null,
            wrongAfterCorrect: false,
            recent: []
        }
        attemptStats.questions[key] = entry
    }
    entry.chapter = chapter
    entry.type = type
    entry.question = question.question
    entry.attempts += 1
    entry.lastAt = now
    entry.lastChosen = chosen || ''
    entry.lastCorrect = !!correct
    if (correct) {
        entry.correct += 1
    } else {
        entry.wrong += 1
        entry.lastWrongAt = now
        if (entry.correct > 0) entry.wrongAfterCorrect = true
    }
    entry.recent = (entry.recent || []).concat([{
        t: now,
        chosen: chosen || '',
        correct: !!correct
    }]).slice(-10)
    scheduleStatsSave()
}

// 构建题目导航
function buildErrQustion(currentQuestionIndex, question) {
    let el = document.querySelector(`li[data-global-index='${currentQuestionIndex}']`)
    if (!el) return
    if (question.chooseRight === false) {
        el.classList.add('incorrect');
        if (el.classList.contains('correct')) el.classList.remove("correct")
    } else if (question.chooseRight === true) {
        el.classList.add("correct")
        if (el.classList.contains('incorrect')) el.classList.remove("incorrect")
    }
}

function buildQuestionList(data) {
    const questionMap = []
    const sections = []
    const keys = new Set()
    let questionIndex = 0;

    const questionList = document.querySelector('.question-list');
    questionList.innerHTML = '';

    Object.keys(data).forEach(chapter => {
        const value = data[chapter] || {}
        const questions = []
        const seen = new Set()
        Object.keys(value).forEach(type => {
            const arr = value[type]
            if (!Array.isArray(arr)) return
            arr.forEach(q => {
                if (!q || seen.has(q)) return
                seen.add(q)
                questions.push(q)
            })
        })
        if (!questions.length) return

        const chapterDiv = document.createElement('div');
        chapterDiv.innerHTML = `<h3>${escapeHtml(chapter)}</h3>`;
        questionList.appendChild(chapterDiv);

        const sectionUl = document.createElement('ul');
        chapterDiv.appendChild(sectionUl);

        // 不定项不再分单选/多选，导航序号在章节内连续
        const type = '不定项'
        const globalIndexes = questions.map((q, idx) => {
            const globalIndex = questionIndex++;
            questionMap[globalIndex] = { chapter, type, index: idx, globalIndex };
            keys.add(makeQuestionKey(chapter, type, q));
            return globalIndex;
        })

        const shownIndexes = getSectionOrder(chapter, type, globalIndexes)
        shownIndexes.forEach((globalIndex, position) => {
            const meta = questionMap[globalIndex]
            const q = questions[meta.index]
            const li = document.createElement('li');
            li.textContent = `${position + 1}`;
            li.dataset.chapter = chapter;
            li.dataset.type = type;
            li.dataset.index = meta.index;
            li.dataset.globalIndex = globalIndex;
            sectionUl.appendChild(li);
            if (q.userAnswer) buildErrQustion(globalIndex, q)
        })

        sections.push({ chapter, type, globalIndexes, shownIndexes, ul: sectionUl })
    });

    // 点击切换题目（用 onclick 覆盖，避免每次重新渲染都叠加一个监听器）
    questionList.onclick = (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        const globalIndex = parseInt(li.dataset.globalIndex, 10);
        currentQuestionIndex = globalIndex
        renderQuestion(data, globalIndex, questionMap);
        document.querySelectorAll('.question-list li').forEach(item => item.classList.remove('active'));
        li.classList.add('active');
    };

    currentQuestionKeys = keys
    return { questionMap, sections, presentation: sections.flatMap(section => section.shownIndexes) }
}

function getSectionOrder(chapter, type, globalIndexes) {
    if (!shuffleQuestionsEnabled) return globalIndexes
    const cacheKey = `${chapter}@@${type}`
    if (!questionOrderCache.has(cacheKey)) {
        questionOrderCache.set(cacheKey, shuffleArray(globalIndexes))
    }
    return questionOrderCache.get(cacheKey)
}

// 选项乱序：显示字母按乱序后的位置重新编 A/B/C/D，判题仍映射回题库原答案
function buildOptionView(question, chapter, type) {
    const originalKeys = Object.keys(question.select || {})
    let arranged = originalKeys
    if (shuffleOptionsEnabled && originalKeys.length > 1) {
        const cacheKey = makeQuestionKey(chapter, type, question)
        if (!optionOrderCache.has(cacheKey)) {
            optionOrderCache.set(cacheKey, shuffleArray(originalKeys))
        }
        arranged = optionOrderCache.get(cacheKey)
    }
    const displayKeys = arranged.map((_, index) => String.fromCharCode(65 + index))
    const displayToOriginal = {}
    const originalToDisplay = {}
    arranged.forEach((originalKey, index) => {
        const displayKey = displayKeys[index]
        displayToOriginal[displayKey] = originalKey
        originalToDisplay[originalKey] = displayKey
    })
    return { displayKeys, displayToOriginal, originalToDisplay }
}

// 渲染题目：所有题目统一按不定项处理（复选框 + 提交）
function renderQuestion(data, globalIndex, questionMap) {
    const { chapter, type, index } = questionMap[globalIndex];
    const question = data[chapter][type][index];
    const resultDiv = document.querySelector('.result');
    resultDiv.innerHTML = '';

    const questionDiv = document.createElement('div');
    questionDiv.className = 'question';
    questionDiv.textContent = question.question;

    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'options';
    const { displayKeys, displayToOriginal, originalToDisplay } = buildOptionView(question, chapter, type)
    const correctCanonical = String(question.answer || '').toUpperCase()
    const correctDisplay = correctCanonical.split('')
        .map(key => originalToDisplay[key])
        .filter(Boolean)
        .join('')
    let lastRecorded = String(question.userAnswer || '').toUpperCase() || null
    const record = (canonical, correct) => {
        if (lastRecorded === canonical) return
        lastRecorded = canonical
        recordAttempt(chapter, type, question, canonical, correct)
    }

    let selectedAnswers = []

    displayKeys.forEach(displayKey => {
        const originalKey = displayToOriginal[displayKey]
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = displayKey;

        input.addEventListener('change', () => {
            if (input.checked) {
                label.classList.add('active');
                if (!selectedAnswers.includes(originalKey)) {
                    selectedAnswers.push(originalKey);
                }
            } else {
                label.classList.remove('active');
                selectedAnswers = selectedAnswers.filter(ans => ans !== originalKey);
            }
        });

        label.appendChild(input);
        label.appendChild(document.createTextNode(`${displayKey}. ${question.select[originalKey]}`));
        optionsDiv.appendChild(label);
    });

    const historyAnswer = String(question.userAnswer || '').toUpperCase()
    if (historyAnswer) {
        selectedAnswers = historyAnswer.split('').filter(key => originalToDisplay[key] !== undefined)
        const selectedDisplay = selectedAnswers.map(key => originalToDisplay[key]).join('')
        optionsDiv.querySelectorAll('input').forEach(input => {
            if (selectedDisplay.includes(input.value)) {
                input.checked = true;
                if (input.parentElement) input.parentElement.classList.add('active')
            }
        });
        checkMultiChoice(optionsDiv, correctDisplay, selectedDisplay);
    }

    const submitBtn = document.createElement('button');
    submitBtn.className = 'submit-btn';
    submitBtn.textContent = '提交';
    submitBtn.addEventListener('click', () => {
        const canonical = selectedAnswers.slice().sort().join('')
        const selectedDisplay = selectedAnswers.map(key => originalToDisplay[key]).filter(Boolean).join('')
        const chooseRight = canonical === correctCanonical.split('').sort().join('')
        question.chooseRight = chooseRight
        question.userAnswer = canonical
        checkMultiChoice(optionsDiv, correctDisplay, selectedDisplay)
        buildErrQustion(globalIndex, question)
        record(canonical, chooseRight)
    });
    resultDiv.appendChild(questionDiv);
    resultDiv.appendChild(optionsDiv);
    resultDiv.appendChild(submitBtn);
}

// 单选题检查（value 和 correctAnswer 都是当前展示顺序下的字母）
function checkSingleChoice(value, correctAnswer, optionsDiv) {

    const selected = value;
    const labels = optionsDiv.querySelectorAll('label');

    let res = false
    labels.forEach(label => {

        const input = label.querySelector('input');
        const key = input.value;
        label.className = '';

        if (key === correctAnswer) {
            label.className = 'correct';

        } else if (key === selected && selected !== correctAnswer) {
            label.className = 'incorrect';

        }
    });
    if (correctAnswer == selected) {
        res = true
    }
    return res
}

// 不定项检查（display 字母）
function checkMultiChoice(optionsDiv, correctAnswer, sortedSelected) {

    const labels = optionsDiv.querySelectorAll('label');
    let res = false
    labels.forEach(label => {
        const input = label.querySelector('input');
        const key = input.value;
        const wasActive = input.checked || label.classList.contains('active');

        label.className = ''; // 重置样式

        if (correctAnswer.includes(key)) {
            label.className = 'correct';
        } else if (sortedSelected.includes(key) && !correctAnswer.includes(key)) {
            label.className = 'incorrect';
        } else if (wasActive) {
            label.className = 'active'; // 保留激活样式
        }
    });
    if (sortedSelected.split('').sort().join('') === correctAnswer.split('').sort().join('')) res = true
    return res
}

function highlightActiveQuestion(globalIndex) {
    document.querySelectorAll('.question-list li').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.globalIndex, 10) === globalIndex)
    })
}

// 初始化
function showResult(data, options) {
    options = options || {}
    data = normalizeBank(data)
    if (!data || Object.keys(data).length === 0) {
        currentData = data || {}
        currentQuestionMap = []
        currentQuestionKeys = new Set()
        document.querySelector('.question-list').innerHTML = ''
        document.querySelector('.result').innerHTML = '<p class="empty-tip">还没有题目，先选择或上传题库吧。</p>'
        return
    }

    // 换了一份题库才重新打乱；重置/保存后的重渲染保持同一套顺序
    if (currentData !== data) {
        questionOrderCache.clear()
        optionOrderCache.clear()
        statsSelectedChapter = null
    }
    currentData = data

    const built = buildQuestionList(data)
    currentQuestionMap = built.questionMap

    let target = null
    if (options.keepGlobalIndex != null && built.presentation.indexOf(options.keepGlobalIndex) !== -1) {
        target = options.keepGlobalIndex
    }
    if (target == null && built.presentation.length) {
        target = built.presentation[0]
    }
    if (target == null) {
        document.querySelector('.result').innerHTML = '<p class="empty-tip">还没有题目，先选择或上传题库吧。</p>'
        return
    }
    currentQuestionIndex = target
    renderQuestion(data, target, currentQuestionMap)
    highlightActiveQuestion(target)
}

function rerenderCurrentQuestion() {
    if (currentData && Object.keys(currentData).length) {
        showResult(currentData, { keepGlobalIndex: currentQuestionIndex })
    }
}

// ---------------- 错题统计面板 ----------------

function formatStatsTime(ts) {
    if (!ts) return '—'
    const d = new Date(ts)
    const pad = n => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function aggregateStats(rows) {
    return rows.reduce((acc, row) => {
        acc.attempts += row.attempts || 0
        acc.correct += row.correct || 0
        acc.wrong += row.wrong || 0
        if ((row.attempts || 0) > 0) acc.attempted += 1
        if ((row.wrong || 0) > 0) acc.wrongQuestions += 1
        if ((row.wrong || 0) >= 2) acc.repeatWrong += 1
        return acc
    }, { attempts: 0, correct: 0, wrong: 0, attempted: 0, wrongQuestions: 0, repeatWrong: 0 })
}

function accuracyText(correct, attempts) {
    if (!attempts) return '—'
    return `${Math.round(correct / attempts * 100)}%`
}

function openStatsPanel() {
    const overlay = document.getElementById('statsOverlay')
    if (!overlay) return
    overlay.hidden = false
    renderStatsPanel()
}

function closeStatsPanel() {
    const overlay = document.getElementById('statsOverlay')
    if (overlay) overlay.hidden = true
}

async function renderStatsPanel() {
    const body = document.getElementById('statsBody')
    const sub = document.getElementById('statsSub')
    if (!body) return

    await initStats()
    const allStats = attemptStats || { questions: {} }
    const allKeys = Object.keys(allStats.questions)
    const scopedToBank = currentQuestionKeys.size > 0
    const rows = allKeys
        .filter(key => !scopedToBank || currentQuestionKeys.has(key))
        .map(key => Object.assign({ key }, allStats.questions[key]))

    // 章节顺序：当前题库的章节优先，其次是历史统计里出现过的章节
    const chapterOrder = []
    if (currentData && Object.keys(currentData).length) {
        Object.keys(currentData).forEach(chapter => {
            if (!chapterOrder.includes(chapter)) chapterOrder.push(chapter)
        })
    }
    rows.forEach(row => {
        if (row.chapter && !chapterOrder.includes(row.chapter)) chapterOrder.push(row.chapter)
    })

    const overall = aggregateStats(rows)
    const byChapter = {}
    chapterOrder.forEach(chapter => { byChapter[chapter] = [] })
    rows.forEach(row => {
        if (!byChapter[row.chapter]) byChapter[row.chapter] = []
        byChapter[row.chapter].push(row)
    })
    const chapterStats = chapterOrder.map(chapter => {
        const stats = aggregateStats(byChapter[chapter] || [])
        stats.chapter = chapter
        return stats
    })
    const maxWrong = chapterStats.reduce((max, item) => Math.max(max, item.wrong), 0)
    const hiddenCount = allKeys.length - rows.length

    if (sub) {
        const scope = scopedToBank ? '当前题库' : '全部题库'
        sub.textContent = `自第一次作答起自动累计（${scope}）· 重置做题记录不会清除统计`
        if (hiddenCount > 0) sub.textContent += ` · 另有 ${hiddenCount} 道其他题库的统计未显示`
    }

    const cards = `
        <div class="stats-cards">
            <div class="stats-card"><span class="num">${overall.attempts}</span><span class="label">累计作答</span></div>
            <div class="stats-card"><span class="num danger">${overall.wrong}</span><span class="label">错误次数</span></div>
            <div class="stats-card"><span class="num ok">${accuracyText(overall.correct, overall.attempts)}</span><span class="label">正确率</span></div>
            <div class="stats-card"><span class="num danger">${overall.wrongQuestions}</span><span class="label">错题数</span></div>
            <div class="stats-card"><span class="num danger">${overall.repeatWrong}</span><span class="label">重复错题</span></div>
        </div>`

    const chapterRows = chapterStats.map(item => {
        const width = maxWrong ? Math.round(item.wrong / maxWrong * 100) : 0
        return `<div class="stats-chapter-row">
            <span class="stats-chapter-label" title="${escapeHtml(item.chapter)}">${escapeHtml(item.chapter)}</span>
            <span class="stats-chapter-track"><i style="width:${width}%"></i></span>
            <span class="stats-chapter-value">错 ${item.wrong} 次 · ${item.wrongQuestions} 题</span>
        </div>`
    }).join('')

    // 明细默认选：上次选中的章节 → 有错题的章节 → 第一章
    const chapterWithWrong = chapterStats.filter(item => item.wrongQuestions > 0)
    if (!statsSelectedChapter || !chapterOrder.includes(statsSelectedChapter)) {
        statsSelectedChapter = chapterWithWrong.length ? chapterWithWrong[0].chapter : (chapterOrder[0] || null)
    }
    const detailRows = statsSelectedChapter
        ? (byChapter[statsSelectedChapter] || [])
            .filter(row => (row.wrong || 0) > 0)
            .sort((a, b) => (b.wrong - a.wrong) || (b.lastWrongAt - a.lastWrongAt))
        : []

    const tabs = chapterOrder.map(chapter => `<button type="button" class="${chapter === statsSelectedChapter ? 'active' : ''}" data-stats-chapter="${escapeHtml(chapter)}">${escapeHtml(chapter)}</button>`).join('')

    const detailHtml = detailRows.length ? `
        <table class="stats-table">
            <thead><tr><th>题目</th><th>作答</th><th>错误</th><th>最近一次</th><th>做了再错</th></tr></thead>
            <tbody>
                ${detailRows.map(row => {
                    const repeat = (row.wrong || 0) >= 2
                    const lastTag = row.lastCorrect === true
                        ? '<span class="stats-tag right">对</span>'
                        : '<span class="stats-tag wrong">错</span>'
                    const repeatText = repeat
                        ? '<span class="stats-tag repeat">是（' + row.wrong + ' 次）</span>'
                        : '否'
                    const extra = row.wrongAfterCorrect ? ' <span class="stats-tag repeat">曾答对后再错</span>' : ''
                    return `<tr>
                        <td class="q" title="${escapeHtml(row.question)}">${escapeHtml(row.question)}</td>
                        <td class="num">${row.attempts || 0}</td>
                        <td class="num">${row.wrong || 0}</td>
                        <td>${lastTag} ${formatStatsTime(row.lastWrongAt || row.lastAt)}</td>
                        <td>${repeatText}${extra}</td>
                    </tr>`
                }).join('')}
            </tbody>
        </table>` : `<div class="stats-empty">${statsSelectedChapter ? '这个章节还没有错题记录。' : '还没有答题记录，先做几道题吧。'}</div>`

    body.innerHTML = `
        ${rows.length === 0 ? '<div class="stats-empty">还没有答题记录，先做几道题吧。答完会自动记录，不需要点保存。</div>' : ''}
        ${cards}
        <section class="stats-section">
            <h3>章节错误对比</h3>
            ${chapterRows || '<div class="stats-empty">还没有答题记录。</div>'}
        </section>
        <section class="stats-section">
            <h3>错题明细</h3>
            ${tabs ? `<div class="stats-tabs">${tabs}</div>` : ''}
            ${detailHtml}
        </section>`
}

async function clearStats() {
    if (!window.confirm('确定清空所有错题统计吗？做题记录不会被删除，但统计历史无法恢复。')) return
    attemptStats = { version: 1, questions: {} }
    await saveStoreData(STATS_RECORD_ID, attemptStats)
    renderStatsPanel()
}

function bindShuffleToggles() {
    const questionToggle = document.getElementById('shuffleQuestions')
    const optionToggle = document.getElementById('shuffleOptions')

    if (questionToggle) {
        questionToggle.checked = shuffleQuestionsEnabled
        questionToggle.addEventListener('change', () => {
            shuffleQuestionsEnabled = questionToggle.checked
            writeLocalFlag('bhu.shuffleQuestions', shuffleQuestionsEnabled)
            questionOrderCache.clear()
            rerenderCurrentQuestion()
        })
    }
    if (optionToggle) {
        optionToggle.checked = shuffleOptionsEnabled
        optionToggle.addEventListener('change', () => {
            shuffleOptionsEnabled = optionToggle.checked
            writeLocalFlag('bhu.shuffleOptions', shuffleOptionsEnabled)
            optionOrderCache.clear()
            rerenderCurrentQuestion()
        })
    }
}

function bindStatsUI() {
    const overlay = document.getElementById('statsOverlay')
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeStatsPanel()
        })
    }
    const closeBtn = document.getElementById('statsClose')
    if (closeBtn) closeBtn.addEventListener('click', closeStatsPanel)
    const openBtn = document.querySelector('.statsButton')
    if (openBtn) openBtn.addEventListener('click', openStatsPanel)
    const clearBtn = document.getElementById('statsClear')
    if (clearBtn) clearBtn.addEventListener('click', clearStats)
    const body = document.getElementById('statsBody')
    if (body) {
        body.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-stats-chapter]')
            if (!tab) return
            statsSelectedChapter = tab.getAttribute('data-stats-chapter')
            renderStatsPanel()
        })
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeStatsPanel()
    })
}

initStats()
bindShuffleToggles()
bindStatsUI()
