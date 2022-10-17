describe('Preview Mode', () => {
  it('enters and exits preview mode', () => {
    Cypress.Cookies.debug(true)
    cy.getCookies().then((cookie) => cy.log('cookies', cookie))
    // preview mode is off by default
    cy.visit('/previewTest')
    cy.findByText('Is preview? No', { selector: 'h1' })

    // enter preview mode
    cy.request('/api/enterPreview').then((response) => {
      expect(response.body).to.have.property('name', 'preview mode')
    })
    cy.visit('/previewTest')
    cy.findByText('Is preview? Yes!', { selector: 'h1' })

    // exit preview mode
    cy.request('/api/exitPreview')
    cy.visit('/previewTest')
    cy.findByText('Is preview? No', { selector: 'h1' })
  })
})
