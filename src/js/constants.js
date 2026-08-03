// Global constants
// Constants for magic strings
const CONSTANTS = {
    APP_NAME: 'scriptum',
    // Keep in sync with src-tauri/Cargo.toml's [package] version.
    APP_VERSION: '0.7.0',

    DB: {
        NAME:    'scriptum-db',
        VERSION: 1
    },

    STORES: {
        BOOKS_READ:   'booksRead',
        READING_LIST: 'readingList',
        MY_LIBRARY:   'myLibrary',
        SETTINGS:     'settings'
    },

    VIEWS: {
        DASHBOARD: 'dashboard',
        ENTER_FINISHED: 'enterFinished',
        REVIEW: 'review',
        EDIT: 'edit',
        STATISTICS: 'statistics',
        SETTINGS: 'settings',
        TO_READ: 'toread',
        MY_LIBRARY: 'myLibrary'
    },

    STORAGE_KEYS: {
        BOOKS_DATA: 'booksData',
        SELECTED_THEME: 'selectedTheme',
        DAILY_READING_PAGES: 'dailyReadingPages'
    },

    THEMES: {
        NORDIC_DARK: 'css/themes/nordic-dark.css',
        NORDIC_LIGHT: 'css/themes/nordic-light.css',
        MATRIX_CODE: 'css/themes/matrix.css'
    },

    MESSAGE_TYPES: {
        INFO: 'info',
        SUCCESS: 'success',
        ERROR: 'error'
    },

    BOOK_FIELDS: {
        FINISHED: 'Finished',
        TITLE: 'Title',
        AUTHOR: 'Author',
        PAGES: 'Pages',
        CATEGORY: 'Category',
        RECOMMEND: 'Recommend',
        ISBN: 'ISBN',
        COMMENTS: 'Comments',
        ID: 'id'
    },

    FILTER_OPERATORS: {
        IS_EMPTY: 'isEmpty',
        CONTAINS: 'contains',
        BETWEEN: 'between',
        LESS_THAN_EQUAL: 'lte',
        GREATER_THAN_EQUAL: 'gte',
        EQUALS: 'equals'
    },

    SORT_DIRECTIONS: {
        ASC: 'asc',
        DESC: 'desc'
    },

    CHART_TYPES: {
        BAR: 'bar',
        LINE: 'line'
    },

    DATE_FORMATS: {
        ISO: 'YYYY-MM-DD',
        STORAGE: 'DD-MMM-YYYY'
    },

    API_DELAYS: {
        QUICK_SEARCH: 300,
        API_RESPECT: 1000,
        DROPDOWN_CLOSE: 10,
        PAUSE_AFTER_SAVE: 3000
    },

    // ISBN match confidence
    CONFIDENCE_LEVELS: {
        MIN_ISBN_LOOKUP: 55,
        GOOD_MATCH: 60
    },

    // # rows in dashboard cards
    ROW_LIMITS: {
        RECENT_FINISHED: 5,
        WHATS_NEXT: 4
    },

    // how many books to process before outputting status message
    ISBN_MSG_INTERVAL: 10
};

const DASHBOARD_CONSTANTS = {
    STORAGE_KEY: 'dashboardCardOrder',
    DEFAULT_ORDER: [
        'quick-stats',
        'quick-actions',
        'recent-books',
        'reading-goals',
        'whats-next',
        'library-stats'
    ],
    DRAG_CLASSES: {
        DRAGGING: 'dashboard-card-dragging',
        DRAG_OVER: 'dashboard-card-drag-over'
    }
};
