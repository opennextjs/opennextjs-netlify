// This is forcing this fixture to produce static html pages router
// to not rely just on Next.js currently always handling default pages router 404.html page
const FullyStatic = () => (
  <div>
    <p>This page is not using getStaticProps()</p>
  </div>
)

export default FullyStatic
