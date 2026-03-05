import { createTheme } from '@mui/material/styles';

// 🎨 Корпоративные цвета РЖД (из руководства по фирменному стилю)
export const RZD_COLORS = {
  // Основной красный РЖД
  primary: '#E21A1A',        // Pantone 1795C
  primaryDark: '#B31515',

  // Серый RZD-Grey
  secondary: '#394A58',      // Pantone 7546 C
  secondaryLight: '#57748B',

  // Дополнительные корпоративные цвета
  blue: '#0066A1',           // RZD-Blue
  green: '#A3A86B',          // RZD-Green
  beige: '#CECCA0',          // RZD-Beige
  orange: '#FF8C00',         // Акцентный оранжевый

  // Системные цвета
  white: '#FFFFFF',
  black: '#000000',
  grey: {
    100: '#F5F5F5',
    200: '#E0E0E0',
    300: '#BDBDBD',
    500: '#9E9E9E',
    700: '#616161',
    900: '#212121',
  },

  // Статусы
  success: '#4CAF50',
  warning: '#FF9800',
  error: '#E21A1A',
  info: '#0066A1',
};

// 🎨 Создание темы MUI с корпоративным стилем РЖД
export const rzdTheme = createTheme({
  palette: {
    primary: {
      main: RZD_COLORS.primary,
      dark: RZD_COLORS.primaryDark,
      contrastText: RZD_COLORS.white,
    },
    secondary: {
      main: RZD_COLORS.secondary,
      light: RZD_COLORS.secondaryLight,
      contrastText: RZD_COLORS.white,
    },
    error: {
      main: RZD_COLORS.error,
    },
    warning: {
      main: RZD_COLORS.warning,
    },
    success: {
      main: RZD_COLORS.success,
    },
    info: {
      main: RZD_COLORS.info,
    },
    background: {
      default: RZD_COLORS.grey[100],
      paper: RZD_COLORS.white,
    },
    text: {
      primary: RZD_COLORS.black,
      secondary: RZD_COLORS.secondary,
    },
  },
  typography: {
    fontFamily: '"Verdana", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: {
      fontWeight: 700,
      fontFamily: '"Verdana", sans-serif',
    },
    h5: {
      fontWeight: 600,
      fontFamily: '"Verdana", sans-serif',
    },
    h6: {
      fontWeight: 600,
      fontFamily: '"Verdana", sans-serif',
    },
    button: {
      fontWeight: 600,
      textTransform: 'none', // Убираем капс у кнопок
    },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          padding: '10px 24px',
          fontSize: '0.95rem',
        },
        contained: {
          boxShadow: 'none',
          '&:hover': {
            boxShadow: '0 4px 8px rgba(226, 26, 26, 0.3)',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 500,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontSize: '0.95rem',
          fontWeight: 500,
        },
      },
    },
  },
});