// Statistics collection and display in charts.

let categoryChart, yearlyChart;


function generateStatistics() {
    // Filter books with dates and extract year
    const datedBooks = books.filter(book => book.Finished).map(book => {
        return { ...book, year: getYearFromFinishedDate(book.Finished) };
    });

    // Calculate totals
    const totalBooks = datedBooks.length;
    const totalPages = datedBooks.reduce((sum, book) => sum + (parseInt(book.Pages) || 0), 0);

    // Category statistics (exclude empty categories)
    const categoryStats = {};
    datedBooks.forEach(book => {
        if (book.Category && book.Category.trim()) {
            categoryStats[book.Category] = (categoryStats[book.Category] || 0) + 1;
        }
    });

    // Yearly statistics
    const yearlyStats = {};
    datedBooks.forEach(book => {
        const year = book.year;
        if (!yearlyStats[year]) {
            yearlyStats[year] = { books: 0, pages: 0, recommend: { Y: 0, N: 0, blank: 0 } };
        }
        yearlyStats[year].books++;
        yearlyStats[year].pages += parseInt(book.Pages) || 0;

        const rec = book.Recommend;
        if (rec === 1 || rec === 'Y') {
            yearlyStats[year].recommend.Y++;
        } else if (rec === 0 || rec === 'N') {
            yearlyStats[year].recommend.N++;
        } else {
            yearlyStats[year].recommend.blank++;
        }
    });

    // Fill in missing years with zeros
    if (Object.keys(yearlyStats).length > 0) {
        const minYear = Math.min(...Object.keys(yearlyStats).map(Number));
        const maxYear = Math.max(...Object.keys(yearlyStats).map(Number));

        for (let year = minYear; year <= maxYear; year++) {
            if (!yearlyStats[year]) {
                yearlyStats[year] = { books: 0, pages: 0, recommend: { Y: 0, N: 0, blank: 0 } };
            }
        }
    }

    return { totalBooks, totalPages, categoryStats, yearlyStats };
}


function renderStatistics() {
    const stats = generateStatistics();

    // Update totals
    document.getElementById('totalBooks').textContent = stats.totalBooks;
    document.getElementById('totalPages').textContent = stats.totalPages.toLocaleString();

    // Render charts
    renderCategoryChart(stats.categoryStats);
    renderYearlyChart(stats.yearlyStats);
}


function renderCategoryChart(categoryStats) {
    try {
        // Force destroy any existing chart first
        const canvas = document.getElementById('categoryChart');
        const existingChart = Chart.getChart(canvas);
        if (existingChart) {
            existingChart.destroy();
        }

        const ctx = canvas.getContext('2d');
        const colors = getThemeColors();

        // Sort categories by count (descending)
        const sortedCategories = Object.entries(categoryStats)
            .sort(([,a], [,b]) => b - a);

        const sortedLabels = sortedCategories.map(([category,]) => category);
        const sortedData = sortedCategories.map(([, count]) => count);

        // Generate different colors for each category
        const categoryColors = sortedLabels.map((_, index) => {
            const baseColors = [colors.primary, colors.secondary, colors.tertiary, '#8fbcbb', '#d08770', '#ebcb8b', '#a3be8c', '#b48ead'];
            return baseColors[index % baseColors.length];
        });

        // Custom plugin to draw labels on bars
        const labelPlugin = {
            id: 'barLabels',
            afterDatasetsDraw(chart) {
                const { ctx, data } = chart;
                const freshColors = getThemeColors();
                ctx.save();

                data.datasets.forEach((dataset, datasetIndex) => {
                    const meta = chart.getDatasetMeta(datasetIndex);
                    meta.data.forEach((bar, index) => {
                        const value = dataset.data[index];

                        ctx.fillStyle = freshColors.primary;
                        ctx.font = '12px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';

                        ctx.fillText(value, bar.x, bar.y - 5);
                    });
                });

                ctx.restore();
            }
        };

        categoryChart = new Chart(ctx, {
            type: CONSTANTS.CHART_TYPES.BAR,
            data: {
                labels: sortedLabels,
                datasets: [{
                    label: 'Books by Category',
                    data: sortedData,
                    backgroundColor: categoryColors,
                    borderColor: categoryColors,
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            color: colors.primary,
                            maxRotation: 45,
                            minRotation: 45
                        }
                    },
                    y: {
                        ticks: {
                            color: colors.primary
                        }
                    }
                }
            },
            plugins: [labelPlugin]
        });
    } catch (error) {
        console.error('Error rendering category chart:', error);
        showMessage('Error displaying category chart', CONSTANTS.MESSAGE_TYPES.ERROR);
    }
}


function renderYearlyChart(yearlyStats) {
    try {
        // Force destroy any existing chart first
        const canvas = document.getElementById('yearlyChart');
        const existingChart = Chart.getChart(canvas);
        if (existingChart) {
            existingChart.destroy();
        }

        const ctx = canvas.getContext('2d');
        const colors = getThemeColors();

        const years = Object.keys(yearlyStats).sort();
        const booksData = years.map(year => yearlyStats[year].books);
        const pagesData = years.map(year => (yearlyStats[year].pages / 1000));
        const recommendY = years.map(year => yearlyStats[year].recommend.Y);

        yearlyChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: years,
                datasets: [
                    {
                        label: 'Books Read',
                        data: booksData,
                        borderColor: colors.primary,
                        backgroundColor: colors.primary,
                        fill: false,
                        tension: 0.1,
                        type: 'line'
                    },
                    {
                        label: 'Pages (÷1000)',
                        data: pagesData,
                        borderColor: colors.secondary,
                        backgroundColor: colors.secondary,
                        fill: false,
                        tension: 0.1,
                        type: 'line'
                    },
                    {
                        label: 'Recommend: Yes',
                        data: recommendY,
                        backgroundColor: colors.tertiary,
                        type: 'bar'
                    }
                ]
            },
            options: {
                responsive: true,
                interaction: {
                    intersect: false
                },
                scales: {
                    x: {
                        ticks: {
                            color: colors.primary
                        }
                    },
                    y: {
                        ticks: {
                            color: colors.primary
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: colors.primary
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error rendering yearly chart:', error);
        showMessage('Error displaying yearly chart', CONSTANTS.MESSAGE_TYPES.ERROR);
    }
}


function destroyCharts() {
    // Destroy by variable reference
    if (categoryChart) {
        categoryChart.destroy();
        categoryChart = null;
    }
    if (yearlyChart) {
        yearlyChart.destroy();
        yearlyChart = null;
    }

    // Force destroy any charts attached to these canvases
    const categoryCanvas = document.getElementById('categoryChart');
    const yearlyCanvas = document.getElementById('yearlyChart');

    if (categoryCanvas) {
        const existingChart = Chart.getChart(categoryCanvas);
        if (existingChart) {
            existingChart.destroy();
        }
    }

    if (yearlyCanvas) {
        const existingChart = Chart.getChart(yearlyCanvas);
        if (existingChart) {
            existingChart.destroy();
        }
    }
}

// Make destroyCharts globally accessible
window.destroyCharts = destroyCharts;
