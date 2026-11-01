document.querySelector('#login').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const result = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: new FormData(form).get('password') }) });
    if (!result.ok) throw Error(result.status === 429 ? 'Слишком много попыток. Повторите через минуту.' : 'Не удалось войти. Проверьте пароль.');
    location.replace('/');
  } catch (error) {
    const message = document.querySelector('#error');
    message.hidden = false;
    message.textContent = error.message;
  } finally { button.disabled = false; }
});
