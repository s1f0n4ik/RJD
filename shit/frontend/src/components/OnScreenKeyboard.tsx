import React, { useEffect, useRef, useState, useCallback } from 'react';
import Keyboard from 'react-simple-keyboard';
import 'react-simple-keyboard/build/css/index.css';
import { Box, IconButton, Paper } from '@mui/material';
import { Close as CloseIcon, Language as LanguageIcon } from '@mui/icons-material';
import { useTouchDevice } from '../utils/useTouchDevice';

type Layout = 'ru' | 'en';

const LAYOUTS: Record<Layout, { default: string[]; shift: string[] }> = {
  en: {
    default: [
      '1 2 3 4 5 6 7 8 9 0 - {bksp}',
      'q w e r t y u i o p [ ] \\',
      "a s d f g h j k l ; ' {enter}",
      '{shift} z x c v b n m , . / {shift}',
      '{lang} {space} {close}',
    ],
    shift: [
      '! @ # $ % ^ & * ( ) _ {bksp}',
      'Q W E R T Y U I O P { } |',
      'A S D F G H J K L : " {enter}',
      '{shift} Z X C V B N M < > ? {shift}',
      '{lang} {space} {close}',
    ],
  },
  ru: {
    default: [
      '1 2 3 4 5 6 7 8 9 0 - {bksp}',
      'й ц у к е н г ш щ з х ъ',
      'ф ы в а п р о л д ж э {enter}',
      '{shift} я ч с м и т ь б ю . {shift}',
      '{lang} {space} {close}',
    ],
    shift: [
      '! " № ; % : ? * ( ) _ {bksp}',
      'Й Ц У К Е Н Г Ш Щ З Х Ъ',
      'Ф Ы В А П Р О Л Д Ж Э {enter}',
      '{shift} Я Ч С М И Т Ь Б Ю , {shift}',
      '{lang} {space} {close}',
    ],
  },
};

const DISPLAY = {
  '{bksp}': '⌫',
  '{enter}': '⏎',
  '{shift}': '⇧',
  '{space}': 'Пробел',
  '{lang}': 'RU/EN',
  '{close}': '✕ Скрыть',
};

const isEditable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  // Исключаем нетекстовые типы
  const nonText = ['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'reset'];
  return !nonText.includes(type);
};

const OnScreenKeyboard: React.FC = () => {
  const isTouch = useTouchDevice();
  const [visible, setVisible] = useState(false);
  const [layoutName, setLayoutName] = useState<'default' | 'shift'>('default');
  const [lang, setLang] = useState<Layout>('ru');
  const targetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Отслеживаем фокус на input/textarea
  useEffect(() => {
    if (!isTouch) return;

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element;
      if (isEditable(el)) {
        targetRef.current = el as HTMLInputElement | HTMLTextAreaElement;
        setVisible(true);
      }
    };

    const onFocusOut = (e: FocusEvent) => {
      // Если фокус уходит в пустоту или на неинпут — скрываем
      // Но НЕ скрываем, если клик пришёл на саму клавиатуру
      const next = e.relatedTarget as Element | null;
      if (next && next.closest('[data-onscreen-keyboard]')) return;
      if (!next || !isEditable(next)) {
        // небольшая задержка, чтобы клик по кнопке клавиатуры успел отработать
        setTimeout(() => {
          const active = document.activeElement;
          if (!isEditable(active)) {
            setVisible(false);
            targetRef.current = null;
          }
        }, 100);
      }
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [isTouch]);

  // Вставка символа в активный input с триггером React-событий
  const insertText = useCallback((text: string) => {
    const el = targetRef.current;
    if (!el) return;

    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const newValue = el.value.slice(0, start) + text + el.value.slice(end);

    // Нативный setter, чтобы React увидел изменение
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, newValue);

    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Ставим курсор после вставленного
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
  }, []);

  const doBackspace = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    let newValue: string;
    let caret: number;
    if (start !== end) {
      newValue = el.value.slice(0, start) + el.value.slice(end);
      caret = start;
    } else if (start > 0) {
      newValue = el.value.slice(0, start - 1) + el.value.slice(start);
      caret = start - 1;
    } else {
      return;
    }
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, newValue);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.setSelectionRange(caret, caret);
  }, []);

  const doEnter = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    // Эмулируем нажатие Enter — многие формы ловят keydown
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, []);

  const onKeyPress = (btn: string) => {
    if (btn === '{bksp}') return doBackspace();
    if (btn === '{enter}') return doEnter();
    if (btn === '{space}') return insertText(' ');
    if (btn === '{shift}') {
      setLayoutName((p) => (p === 'default' ? 'shift' : 'default'));
      return;
    }
    if (btn === '{lang}') {
      setLang((p) => (p === 'ru' ? 'en' : 'ru'));
      return;
    }
    if (btn === '{close}') {
      setVisible(false);
      targetRef.current?.blur();
      targetRef.current = null;
      return;
    }
    insertText(btn);
    // Автоматически снимаем shift после одной буквы
    if (layoutName === 'shift') setLayoutName('default');
  };

  if (!isTouch || !visible) return null;

  const layout = LAYOUTS[lang];

  return (
    <Paper
      data-onscreen-keyboard
      elevation={12}
      onMouseDown={(e) => e.preventDefault()} // не терять фокус инпута
      sx={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2000,
        p: 1,
        bgcolor: '#1e1e1e',
        borderTop: '2px solid #333',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
        <IconButton
          size="small"
          onClick={() => setLang((p) => (p === 'ru' ? 'en' : 'ru'))}
          sx={{ color: 'white' }}
          title="Сменить язык"
        >
          <LanguageIcon fontSize="small" />
          <Box component="span" sx={{ ml: 0.5, fontSize: 12 }}>
            {lang.toUpperCase()}
          </Box>
        </IconButton>
        <IconButton
          size="small"
          onClick={() => {
            setVisible(false);
            targetRef.current?.blur();
            targetRef.current = null;
          }}
          sx={{ color: 'white' }}
          title="Скрыть клавиатуру"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <Keyboard
        layout={layout}
        layoutName={layoutName}
        display={DISPLAY}
        onKeyPress={onKeyPress}
        theme="hg-theme-default hg-layout-default osk-dark"
        physicalKeyboardHighlight={false}
        preventMouseDownDefault
      />
      <style>{`
        .osk-dark.hg-theme-default { background: transparent; }
        .osk-dark .hg-button {
          height: 56px;
          font-size: 18px;
          background: #2d2d2d;
          color: white;
          border: 1px solid #444;
          border-radius: 6px;
        }
        .osk-dark .hg-button:active { background: #1976d2; }
        .osk-dark .hg-row { margin-bottom: 6px; }
      `}</style>
    </Paper>
  );
};

export default OnScreenKeyboard;