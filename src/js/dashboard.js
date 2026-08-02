// functions that create and display the dashboard

async function renderDashboard() {
    // Calculate stats
    const totalBooks = books.length;
    const totalPages = books.reduce((sum, book) => sum + (parseInt(book.Pages) || 0), 0);
    const currentYear = new Date().getFullYear();
    const thisYearBooks = books.filter(book => {
        if (!book[CONSTANTS.BOOK_FIELDS.FINISHED]) return false;
        const year = book[CONSTANTS.BOOK_FIELDS.FINISHED].split('-')[2];
        return parseInt(year) === currentYear;
    });
    const thisYearBooksCount = thisYearBooks.length;
    const thisYearPages = thisYearBooks.reduce((sum, book) => sum + (parseInt(book.Pages) || 0), 0);

    // Calculate average pages per day for this year
    const now = new Date();
    const startOfYear = new Date(currentYear, 0, 1);
    const daysSinceStartOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24)) + 1;
    const avgPagesDay = daysSinceStartOfYear > 0 ? Math.round(thisYearPages / daysSinceStartOfYear) : 0;

    // Update dashboard stats
    document.getElementById('dashTotalBooks').textContent = totalBooks;
    document.getElementById('dashTotalPages').textContent = totalPages.toLocaleString();
    document.getElementById('dashThisYear').textContent = thisYearBooksCount;
    document.getElementById('dashThisYearPages').textContent = thisYearPages.toLocaleString();
    document.getElementById('dashAvgPagesDay').textContent = avgPagesDay.toLocaleString();

    // Try to load saved order first
    const orderLoaded = await loadDashboardOrder();

    // ALWAYS render the dynamic content, regardless of saved order
    renderRecentBooks();
    renderReadingGoals();
    renderWhatsNext();
    renderLibraryStats();

    // Re-render charts and enable drag-drop after content is loaded
    setTimeout(() => {
        const dailyGoal = parseInt(localStorage.getItem(CONSTANTS.STORAGE_KEYS.DAILY_READING_PAGES)) || null;
        if (dailyGoal) {
            const chartCanvas = document.getElementById('readingGoalChart');
            if (chartCanvas) {
                renderReadingGoalChart(dailyGoal);
            }
        }
        enableDashboardDragDrop();
    }, 50);
}


function renderRecentBooks() {
    const recentBooksContainer = document.getElementById('recentBooks');

    // Get books with dates, sort by most recent, take top 5
    const recentBooks = books
          .filter(book => book[CONSTANTS.BOOK_FIELDS.FINISHED])
          .sort((a, b) => {
              const dateA = new Date(dateToISO(a[CONSTANTS.BOOK_FIELDS.FINISHED]));
              const dateB = new Date(dateToISO(b[CONSTANTS.BOOK_FIELDS.FINISHED]));
              return dateB - dateA;
          })
          .slice(0, CONSTANTS.ROW_LIMITS.RECENT_FINISHED);

    if (recentBooks.length === 0) {
        recentBooksContainer.innerHTML = '<p class="goal-placeholder">No books finished yet</p>';
        return;
    }

    const html = recentBooks.map(book => `
        <div class="recent-book-item">
            <div class="recent-book-title">${book[CONSTANTS.BOOK_FIELDS.TITLE]}</div>
            <div class="recent-book-author">by ${book[CONSTANTS.BOOK_FIELDS.AUTHOR]}</div>
        </div>
    `).join('');

    recentBooksContainer.innerHTML = html;
}


async function renderReadingGoals() {
    const goalDisplay = document.getElementById('goalDisplay');
    const settings = await loadSettingsFromDB() || {};
    const dailyGoal = settings.dailyReadingPages || null;

    if (!dailyGoal) {
        goalDisplay.innerHTML = '<p class="goal-placeholder">Set a daily reading goal in Settings to track progress</p>';
        // Clear any existing chart
        const existingChart = Chart.getChart('readingGoalChart');
        if (existingChart) {
            existingChart.destroy();
        }
        return;
    }

    goalDisplay.innerHTML = `<p class="goal-current">Daily Goal: ${dailyGoal} pages</p>`;
    renderReadingGoalChart(dailyGoal);
}


function renderReadingGoalChart(dailyGoal) {
    const ctx = document.getElementById('readingGoalChart').getContext('2d');
    const colors = getThemeColors();

    // Calculate current progress
    const now = new Date();
    const currentYear = now.getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear, 11, 31);
    const daysSinceStart = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));
    const totalDaysInYear = Math.floor((endOfYear - startOfYear) / (1000 * 60 * 60 * 24)) + 1;

    // Get actual pages read this year
    const thisYearBooks = books.filter(book => {
        if (!book[CONSTANTS.BOOK_FIELDS.FINISHED]) return false;
        const year = book[CONSTANTS.BOOK_FIELDS.FINISHED].split('-')[2];
        return parseInt(year) === currentYear;
    });
    const actualPages = thisYearBooks.reduce((sum, book) =>
        sum + (parseInt(book[CONSTANTS.BOOK_FIELDS.PAGES]) || 0), 0);


    // Create goal line data
    const goalLineData = [
        {x: 0, y: 0},
        {x: totalDaysInYear, y: dailyGoal * totalDaysInYear}
    ];

    // Create vertical line data for plus marker
    const verticalLineData = [
        {x: daysSinceStart, y: 0},
        {x: daysSinceStart, y: Math.max(actualPages, dailyGoal * daysSinceStart) + 500}
    ];

    // Create horizontal line data for plus marker
    const horizontalLineData = [
        {x: 0, y: actualPages},
        {x: totalDaysInYear, y: actualPages}
    ];

    // Destroy existing chart
    const existingChart = Chart.getChart('readingGoalChart');
    if (existingChart) {
        existingChart.destroy();
    }

    // Create new chart
    new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'Goal Progress',
                    data: goalLineData,
                    borderColor: colors.secondary,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0
                },
                {
                    label: 'Current Day',
                    data: verticalLineData,
                    borderColor: colors.primary,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    borderDash: [5, 5],
                    tension: 0
                },
                {
                    label: 'Actual Progress',
                    data: horizontalLineData,
                    borderColor: colors.primary,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    borderDash: [5, 5],
                    tension: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    min: 0,
                    max: totalDaysInYear,
                    title: {
                        display: true,
                        text: 'Day of Year',
                        color: colors.primary
                    },
                    ticks: {
                        color: colors.primary
                    }
                },
                y: {
                    min: 0,
                    title: {
                        display: true,
                        text: 'Total Pages',
                        color: colors.primary
                    },
                    ticks: {
                        color: colors.primary
                    }
                }
            }
        }
    });
}


function renderWhatsNext() {
    const whatsNextContainer = document.getElementById('whatsNextContent');

    if (readingList.length === 0) {
        whatsNextContainer.innerHTML = '<p class="goal-placeholder">No books in reading list yet</p>';
        return;
    }

    // Sort by rank (ranked items first, then unranked), take first 5
    const sortedList = [...readingList]
        .sort((a, b) => {
            if (a.Rank && b.Rank) return a.Rank - b.Rank;
            if (a.Rank && !b.Rank) return -1;
            if (!a.Rank && b.Rank) return 1;
            return 0;
        })
        .slice(0, CONSTANTS.ROW_LIMITS.WHATS_NEXT);

    const html = sortedList.map((book, index) => {
        const rankDisplay = book.Rank || 'Unranked';
        return `
            <div class="whats-next-item">
                <div class="whats-next-rank">${rankDisplay}</div>
                <div class="whats-next-details">
                    <div class="whats-next-title">${book[CONSTANTS.BOOK_FIELDS.TITLE]}</div>
                    <div class="whats-next-author">by ${book[CONSTANTS.BOOK_FIELDS.AUTHOR]}</div>
                </div>
            </div>
        `;
    }).join('');

    whatsNextContainer.innerHTML = html;
}


function renderLibraryStats() {
    const totalBooks = myLibrary.length;
    const noCategoryCount = myLibrary.filter(book => !book.Category || book.Category.trim() === '').length;
    const noISBNCount = myLibrary.filter(book => !book.ISBN || book.ISBN.trim() === '').length;
    const checkedOutCount = myLibrary.filter(book => book.Patron).length;

    document.getElementById('dashLibraryTotal').textContent = totalBooks;
    document.getElementById('dashLibraryNoCategory').textContent = noCategoryCount;
    document.getElementById('dashLibraryNoISBN').textContent = noISBNCount;
    document.getElementById('dashLibraryCheckedOut').textContent = checkedOutCount;
}


// Simple drag and drop for dashboard cards
// Simple drag and drop for dashboard cards
let draggedCard = null;

async function enableDashboardDragDrop() {
    const cards = document.querySelectorAll('.dashboard-card');

    cards.forEach(card => {
        card.draggable = true;
        card.style.cursor = 'move';

        card.ondragstart = function(e) {
            draggedCard = this;
            this.style.opacity = '0.5';
            e.dataTransfer.setData('text/plain', this.id);
            e.dataTransfer.effectAllowed = 'move';
        };

        card.ondragover = function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        };

        card.ondrop = async function(e) {
            e.preventDefault();
            if (draggedCard !== this) {
                const container = this.parentNode;
                const cards = Array.from(container.children);
                const draggedIndex = cards.indexOf(draggedCard);
                const targetIndex = cards.indexOf(this);
                draggedCard.remove();
                if (targetIndex < draggedIndex) {
                    container.insertBefore(draggedCard, this);
                } else {
                    container.insertBefore(draggedCard, this.nextSibling);
                }
                await saveDashboardOrder();
                showMessage('Dashboard cards reordered', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            }
        };

        card.ondragend = function(e) {
            this.style.opacity = '1';
            draggedCard = null;
        };
    });
}


async function saveDashboardOrder() {
    const cards = document.querySelectorAll('.dashboard-card');
    const order = Array.from(cards).map(card => card.id);
    const current = await loadSettingsFromDB() || {};
    await saveSettingsToDB({ ...current, dashboardCardOrder: order });
}

async function loadDashboardOrder() {
    const settings = await loadSettingsFromDB() || {};
    const savedOrder = settings.dashboardCardOrder;
    if (!savedOrder || !Array.isArray(savedOrder) || savedOrder.length !== 6) return false;

    const dashboardGrid = document.querySelector('.dashboard-grid');
    if (!dashboardGrid) return false;

    const cardMap = {};
    dashboardGrid.querySelectorAll('.dashboard-card').forEach(card => {
        cardMap[card.id] = card;
    });

    savedOrder.forEach(cardId => {
        if (cardMap[cardId]) {
            dashboardGrid.appendChild(cardMap[cardId]);
        }
    });

    return true;
}
