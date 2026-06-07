(function () {
  // Copy buttons. Two flavors:
  //   data-copy-target="<elementId>"  -> copies that element's .value (e.g. the prompt textarea)
  //   data-copy-text                  -> copies the textContent of the referenced code block,
  //                                       resolved via data-copy-for="<elementId>"
  const buttons = document.querySelectorAll("[data-copy-target], [data-copy-for]");
  if (!buttons.length) return;

  buttons.forEach((button) => {
    const originalText = button.textContent;

    button.addEventListener("click", async () => {
      let text = "";
      if (button.dataset.copyTarget) {
        const target = document.getElementById(button.dataset.copyTarget);
        if (!target) return;
        target.focus();
        target.select?.();
        text = target.value !== undefined ? target.value : target.textContent;
      } else {
        const source = document.getElementById(button.dataset.copyFor);
        if (!source) return;
        text = source.textContent.trim();
      }

      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        document.execCommand("copy");
        button.textContent = "Selected";
      }

      window.setTimeout(() => {
        button.textContent = originalText;
      }, 1400);
    });
  });
})();
