import { useState } from 'react';
import { Navbar } from '../components/Navbar';

interface FAQItem {
  id: string;
  question: string;
  answer: string;
  category: string;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    id: 'what-is-quorum',
    question: 'What is QuorumProof?',
    answer: 'QuorumProof is a decentralized professional credential verification platform built on Stellar Soroban. It allows engineers to create portable, tamper-proof credentials verified by a personal trust network (quorum slice) of universities, licensing bodies, and employers.',
    category: 'General',
  },
  {
    id: 'how-credentials-work',
    question: 'How do credentials work?',
    answer: 'Credentials are issued as Soulbound Tokens (SBTs) on the Stellar blockchain. Each credential contains information about your qualification, issuer, and expiration date. They are non-transferable and tied to your Stellar wallet address.',
    category: 'Credentials',
  },
  {
    id: 'what-is-quorum-slice',
    question: 'What is a Quorum Slice?',
    answer: 'A Quorum Slice is your personal trust network consisting of attestors (university, licensing body, employers) who co-sign your credentials. You define the threshold of how many attestors must agree for a credential to be considered verified.',
    category: 'Quorum Slices',
  },
  {
    id: 'create-quorum-slice',
    question: 'How do I create a Quorum Slice?',
    answer: 'Navigate to the Slice Builder page, add attestor addresses (Stellar accounts), set a threshold for required signatures, and submit. Your slice will be stored on-chain and can be used to attest credentials.',
    category: 'Quorum Slices',
  },
  {
    id: 'issue-credential',
    question: 'How do I issue a credential?',
    answer: 'Go to the Issue Credential page, select the credential type (degree, license, employment, etc.), provide metadata, and submit. The credential will be created on-chain and can then be attested by your quorum slice members.',
    category: 'Credentials',
  },
  {
    id: 'verify-credential',
    question: 'How do I verify someone else\'s credential?',
    answer: 'Use the Verify page to search for a credential by ID or subject address. You can view the credential details, attestation status, and audit trail without needing to connect your wallet.',
    category: 'Verification',
  },
  {
    id: 'export-credentials',
    question: 'Can I export my credentials?',
    answer: 'Yes! From your Dashboard, click the Export button to download your credentials in JSON or CSV format. This is useful for sharing with employers or archiving.',
    category: 'Credentials',
  },
  {
    id: 'revoke-credential',
    question: 'How do I revoke a credential?',
    answer: 'Navigate to the credential detail page and click the Revoke button. Once revoked, the credential will be marked as invalid and cannot be used for verification.',
    category: 'Credentials',
  },
  {
    id: 'notifications',
    question: 'What are notifications?',
    answer: 'Notifications keep you updated on important events like credential attestations, revocations, and expirations. Click the bell icon in the navbar to view your notification center.',
    category: 'General',
  },
  {
    id: 'privacy',
    question: 'Is my data private?',
    answer: 'QuorumProof is privacy-first. You control what information is revealed and to whom. Credentials are stored on-chain but you decide what metadata to include.',
    category: 'Security',
  },
  {
    id: 'wallet-connection',
    question: 'Why do I need to connect my wallet?',
    answer: 'Your wallet proves ownership of your Stellar account and allows you to sign transactions for issuing, attesting, and revoking credentials.',
    category: 'Wallet',
  },
  {
    id: 'supported-networks',
    question: 'What networks are supported?',
    answer: 'QuorumProof supports Stellar testnet, mainnet, and futurenet. You can switch networks in your wallet settings.',
    category: 'General',
  },
];

export default function Help() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  const categories = ['All', ...new Set(FAQ_ITEMS.map(item => item.category))];
  const filteredItems = selectedCategory === 'All'
    ? FAQ_ITEMS
    : FAQ_ITEMS.filter(item => item.category === selectedCategory);

  return (
    <>
      <Navbar />
      <main className="container help-main">
        <header className="help-header">
          <h1 className="help-title">Help & FAQ</h1>
          <p className="help-subtitle">Find answers to common questions about QuorumProof</p>
        </header>

        <div className="help-content">
          <div className="help-sidebar">
            <h3 className="help-sidebar-title">Categories</h3>
            <div className="category-list">
              {categories.map(category => (
                <button
                  key={category}
                  className={`category-btn ${selectedCategory === category ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <div className="help-main-content">
            <div className="faq-list">
              {filteredItems.map(item => (
                <div key={item.id} className="faq-item">
                  <button
                    className="faq-question"
                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  >
                    <span>{item.question}</span>
                    <span className="faq-toggle">
                      {expandedId === item.id ? '−' : '+'}
                    </span>
                  </button>
                  {expandedId === item.id && (
                    <div className="faq-answer">
                      {item.answer}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {filteredItems.length === 0 && (
              <div className="help-empty">
                <p>No FAQs found in this category.</p>
              </div>
            )}
          </div>
        </div>

        <section className="help-section">
          <h2 className="help-section-title">Still Need Help?</h2>
          <div className="help-resources">
            <div className="help-resource-card">
              <div className="help-resource-icon">📚</div>
              <h3>Documentation</h3>
              <p>Read our comprehensive documentation for detailed guides and API references.</p>
              <a href="https://github.com/QuorumProof/QuorumProof/tree/main/docs" target="_blank" rel="noopener" className="btn btn--ghost btn--sm">
                View Docs
              </a>
            </div>

            <div className="help-resource-card">
              <div className="help-resource-icon">💬</div>
              <h3>Community</h3>
              <p>Join our community to discuss features, ask questions, and share feedback.</p>
              <a href="https://github.com/QuorumProof/QuorumProof/discussions" target="_blank" rel="noopener" className="btn btn--ghost btn--sm">
                Join Community
              </a>
            </div>

            <div className="help-resource-card">
              <div className="help-resource-icon">🐛</div>
              <h3>Report Issues</h3>
              <p>Found a bug? Let us know by opening an issue on GitHub.</p>
              <a href="https://github.com/QuorumProof/QuorumProof/issues" target="_blank" rel="noopener" className="btn btn--ghost btn--sm">
                Report Bug
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">
            Stellar Soroban
          </a>{' '}
          ·{' '}
          <a href="https://github.com/QuorumProof/QuorumProof" target="_blank" rel="noopener">
            QuorumProof
          </a>
        </div>
      </footer>
    </>
  );
}
