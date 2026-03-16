class MyWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    const userId = this.getAttribute("user-id") || "1";
    const res = await fetch(`https://jsonplaceholder.typicode.com/users/${userId}`);
    const user = await res.json();

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: sans-serif; padding: 1rem; border: 1px solid #ccc; border-radius: 8px; }
        h2 { margin: 0 0 0.5rem; }
        p { margin: 0.25rem 0; color: #666; }
      </style>
      <h2>${user.name}</h2>
      <p>${user.email}</p>
      <p>${user.company.catchPhrase}</p>
    `;
  }
}

customElements.define("my-widget", MyWidget);
