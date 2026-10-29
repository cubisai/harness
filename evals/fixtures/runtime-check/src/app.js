// Renders the shop banner when run directly.
function render() {
  const banner = { title: "CubiQ shop", image: placeholderSVG };
  return `${banner.title} [${banner.image ? "img" : "no img"}]`;
}

console.log(render());
