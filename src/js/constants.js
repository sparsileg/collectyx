// Global constants
// Constants for magic strings
const CONSTANTS = {
    APP_NAME: 'Collectyx',
    // Keep in sync with src-tauri/Cargo.toml's [package] version.
    APP_VERSION: '0.1.0',

    DB: {
        NAME:    'collectyx-db',
        VERSION: 1
    },

    // Owner value for every row in v1. The schema carries `owner` so a
    // future multi-user sync doesn't need a migration, but v1 has no auth.
    DEFAULT_OWNER: 'local',

    // Object stores (web) / tables (Tauri). Names match the SQL tables
    // exactly so both backends refer to the same thing.
    STORES: {
        MEDIA_TYPES: 'media_types',
        ITEMS:       'items',
        CONSUMED:    'consumed',
        QUEUED:      'queued',
        OWNED:       'owned',
        TAGS:        'tags',
        ITEM_TAGS:   'item_tags',
        SETTINGS:    'settings'
    },

    // The three collection roles, used to look up per-collection field
    // maps and Rust command names.
    COLLECTIONS: {
        CONSUMED: 'consumed',
        QUEUED:   'queued',
        OWNED:    'owned'
    },

    // v1 ships exactly one media type.
    MEDIA_TYPE_BOOKS: 1,

    VIEWS: {
        DASHBOARD: 'dashboard',
        QUEUED: 'queued',
        CONSUMED: 'consumed',
        OWNED: 'owned',
        TAGS: 'tags',
        STATISTICS: 'statistics'
    },

    STORAGE_KEYS: {
        BOOKS_DATA: 'booksData',
        SELECTED_THEME: 'selectedTheme',
        DAILY_READING_PAGES: 'dailyReadingPages'
    },

    THEMES: {
        DARK: 'css/themes/dark.css',
        LIGHT: 'css/themes/light.css',
        MATRIX_CODE: 'css/themes/matrix.css',
        FLAT: 'css/themes/flat.css'
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
        DROPDOWN_CLOSE: 10,
        PAUSE_AFTER_SAVE: 3000
    },

    // # rows in dashboard cards
    ROW_LIMITS: {
        RECENT_FINISHED: 5,
        WHATS_NEXT: 4
    }
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
