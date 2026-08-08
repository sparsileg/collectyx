// Statistics collection and display in charts.

let topTagsChart, yearlyChart;


async function generateStatistics() {
    const [consumed, tags] = await Promise.all([
        DBManager.getCollection(CONSTANTS.COLLECTIONS.CONSUMED),
        DBManager.getAllTags(),
    ]);

    // Filter books with dates and extract year. Records whose Finished
    // value doesn't yield a plausible year are dropped here rather than
    // rendered with a garbage year (COLLECTYX-SEC-28) — the underlying
    // value stays in the database untouched; this is a display-time guard,
    // not a data repair.
    const datedBooks = consumed
        .filter(book => book.Finished)
        .map(book => ({ ...book, year: getYearFromFinishedDate(book.Finished) }))
        .filter(book => book.year !== null);

    // Calculate totals
    const totalBooks = datedBooks.length;
    const totalPages = datedBooks.reduce((sum, book) => sum + (parseInt(book.Pages) || 0), 0);

    // Top tags, same query and limit the Dashboard's Top Tags card uses
    const topTags = [...tags]
        .sort((a, b) => b.Count - a.Count)
        .slice(0, CONSTANTS.ROW_LIMITS.TOP_TAGS);

    // Yearly statistics
    const yearlyStats = {};
    datedBooks.forEach(book => {
        const year = book.year;
        if (!yearlyStats[year]) {
            yearlyStats[year] = { books: 0, pages: 0 };
        }
        yearlyStats[year].books++;
        yearlyStats[year].pages += parseInt(book.Pages) || 0;
    });

    // Fill in missing years with zeros. reduce() rather than Math.min/max
    // with a spread — spreading a large key array into an argument list
    // throws RangeError, a second failure mode from the same root cause
    // getYearFromFinishedDate now guards against. The span is additionally
    // capped at MAX_YEARLY_FILL_SPAN so even a plausible-but-huge range
    // (already bounded 1000–2200 by getYearFromFinishedDate, so this is
    // belt-and-suspenders) can't blow up the loop.
    const MAX_YEARLY_FILL_SPAN = 200;
    const years = Object.keys(yearlyStats).map(Number);
    if (years.length > 0) {
        const minYear = years.reduce((a, b) => Math.min(a, b));
        let maxYear = years.reduce((a, b) => Math.max(a, b));
        if (maxYear - minYear > MAX_YEARLY_FILL_SPAN) {
            maxYear = minYear + MAX_YEARLY_FILL_SPAN;
        }

        for (let year = minYear; year <= maxYear; year++) {
            if (!yearlyStats[year]) {
                yearlyStats[year] = { books: 0, pages: 0 };
            }
        }
    }

    return { totalBooks, totalPages, topTags, yearlyStats };
}


async function renderStatistics() {
    const stats = await generateStatistics();

    // Update totals
    document.getElementById('totalBooks').textContent = stats.totalBooks;
    document.getElementById('totalPages').textContent = stats.totalPages.toLocaleString();

    // Render charts
    renderTopTagsChart(stats.topTags);
    renderYearlyChart(stats.yearlyStats);
}


function renderTopTagsChart(topTags) {
    try {
        // Force destroy any existing chart first
        const canvas = document.getElementById('topTagsChart');
        const existingChart = Chart.getChart(canvas);
        if (existingChart) {
            existingChart.destroy();
        }

        const ctx = canvas.getContext('2d');
        const colors = getThemeColors();

        const sortedLabels = topTags.map(tag => tag.Name);
        const sortedData = topTags.map(tag => tag.Count);

        // Generate different colors for each tag
        const tagColors = sortedLabels.map((_, index) => {
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

        topTagsChart = new Chart(ctx, {
            type: CONSTANTS.CHART_TYPES.BAR,
            data: {
                labels: sortedLabels,
                datasets: [{
                    label: 'Books by Tag',
                    data: sortedData,
                    backgroundColor: tagColors,
                    borderColor: tagColors,
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
        console.error('Error rendering top tags chart:', error);
        showMessage('Error displaying top tags chart', CONSTANTS.MESSAGE_TYPES.ERROR);
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

        // Both datasets already share one axis — compute its range up
        // front so the mirrored right-side axis below matches exactly,
        // rather than depending on Chart.js's own left-axis autoscale.
        const axisMax = Math.max(0, ...booksData, ...pagesData);
        const niceMax = axisMax === 0 ? 10 : Math.ceil(axisMax * 1.1);

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
                        type: 'line',
                        yAxisID: 'y'
                    },
                    {
                        label: 'Pages (÷1000)',
                        data: pagesData,
                        borderColor: colors.secondary,
                        backgroundColor: colors.secondary,
                        fill: false,
                        tension: 0.1,
                        type: 'line',
                        yAxisID: 'y'
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
                        type: 'linear',
                        position: 'left',
                        min: 0,
                        max: niceMax,
                        ticks: {
                            color: colors.primary
                        }
                    },
                    y1: {
                        type: 'linear',
                        position: 'right',
                        min: 0,
                        max: niceMax,
                        ticks: {
                            color: colors.primary
                        },
                        grid: {
                            drawOnChartArea: false
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
    if (topTagsChart) {
        topTagsChart.destroy();
        topTagsChart = null;
    }
    if (yearlyChart) {
        yearlyChart.destroy();
        yearlyChart = null;
    }

    // Force destroy any charts attached to these canvases
    const topTagsCanvas = document.getElementById('topTagsChart');
    const yearlyCanvas = document.getElementById('yearlyChart');

    if (topTagsCanvas) {
        const existingChart = Chart.getChart(topTagsCanvas);
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
