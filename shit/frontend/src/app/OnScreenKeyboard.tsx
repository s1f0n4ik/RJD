import { useCallback, useEffect, useRef, useState } from 'react';
import Keyboard from 'react-simple-keyboard';
import 'react-simple-keyboard/build/css/index.css';
import { useTouchDevice } from '../utils/useTouchDevice';
import './keyboard.css';

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

const NON_TEXT = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'reset']);

const isEditable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !NON_TEXT.has((el as HTMLInputElement).type);
};

// Значение ставится нативным сеттером, иначе React не увидит изменение
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(caret, caret);
};

/**
 * Экранная клавиатура для сенсорных изделий: всплывает под любым текстовым
 * полем документа, на устройствах с мышью не существует.
 */
export function OnScreenKeyboard() {
  const isTouch = useTouchDevice();
  const [visible, setVisible] = useState(false);
  const [layoutName, setLayoutName] = useState<'default' | 'shift'>('default');
  const [lang, setLang] = useState<Layout>('ru');
  const targetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isTouch) return;

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element;
      if (isEditable(el)) {
        targetRef.current = el;
        setVisible(true);
      }
    };

    const onFocusOut = (e: FocusEvent) => {
      // Клик по самой клавиатуре фокус не уводит
      const next = e.relatedTarget as Element | null;
      if (next && next.closest('[data-onscreen-keyboard]')) return;
      // Пауза даёт клику по клавише отработать до проверки
      setTimeout(() => {
        if (!isEditable(document.activeElement)) {
          setVisible(false);
          targetRef.current = null;
        }
      }, 100);
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [isTouch]);

  const insertText = useCallback((text: string) => {
    const el = targetRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setValue(el, el.value.slice(0, start) + text + el.value.slice(end), start + text.length);
  }, []);

  const backspace = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start !== end) setValue(el, el.value.slice(0, start) + el.value.slice(end), start);
    else if (start > 0) setValue(el, el.value.slice(0, start - 1) + el.value.slice(start), start - 1);
  }, []);

  const close = () => {
    setVisible(false);
    targetRef.current?.blur();
    targetRef.current = null;
  };

  const onKeyPress = (btn: string) => {
    if (btn === '{bksp}') return backspace();
    // Формы ловят Enter по keydown
    if (btn === '{enter}') return targetRef.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (btn === '{space}') return insertText(' ');
    if (btn === '{shift}') return setLayoutName(p => (p === 'default' ? 'shift' : 'default'));
    if (btn === '{lang}') return setLang(p => (p === 'ru' ? 'en' : 'ru'));
    if (btn === '{close}') return close();
    insertText(btn);
    // Shift действует на одну букву
    if (layoutName === 'shift') setLayoutName('default');
  };

  if (!isTouch || !visible) return null;

  return (
    <div className="osk" data-onscreen-keyboard onMouseDown={e => e.preventDefault()}>
      <Keyboard
        layout={LAYOUTS[lang]}
        layoutName={layoutName}
        display={DISPLAY}
        onKeyPress={onKeyPress}
        theme="hg-theme-default hg-layout-default osk-theme"
        physicalKeyboardHighlight={false}
        preventMouseDownDefault
      />
    </div>
  );
}
