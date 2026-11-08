import {describe, expect, it} from 'vitest';
import {getPaperPdfSite, resolvePaperPdfUrl} from '@/src/features/document-translation/core/paperPdfSites';

const hfPaper = 'https://huggingface.co/papers/2501.12948';
const hfPdf = 'https://arxiv.org/pdf/2501.12948';
const aclPaper = 'https://aclanthology.org/2024.acl-long.1/';
const aclPdf = 'https://aclanthology.org/2024.acl-long.1.pdf';
const cvfFolder = 'https://openaccess.thecvf.com/content/ICCV2023';
const cvfSlug = 'Kirillov_Segment_Anything_ICCV_2023_paper';
const cvfPaper = `${cvfFolder}/html/${cvfSlug}.html`;
const cvfPdf = `${cvfFolder}/papers/${cvfSlug}.pdf`;
const neuripsFolder = 'https://proceedings.neurips.cc/paper_files/paper/2024';
const neuripsId = '9d41fddf3169f4df3025fc60bfac94fa';
const neuripsTrack = 'Datasets_and_Benchmarks_Track';
const neuripsPaper = `${neuripsFolder}/hash/${neuripsId}-Abstract-${neuripsTrack}.html`;
const neuripsPdf = `${neuripsFolder}/file/${neuripsId}-Paper-${neuripsTrack}.pdf`;
const legacyNeuripsFolder = 'https://papers.nips.cc/paper/2017';
const legacyNeuripsId = '3f5ee243547dee91fbd053c1c4a845aa';
const legacyCvfFolder = 'https://openaccess.thecvf.com/content_cvpr_2016';
const legacyCvfSlug = 'He_Deep_Residual_Learning_CVPR_2016_paper';
const cvfWorkshopFolder = 'https://openaccess.thecvf.com/content/CVPR2024W/PV';
const cvfWorkshopSlug = 'Misra_Uncovering_the_Hidden_Cost_of_Model_Compression_CVPRW_2024_paper';

describe('same-paper native PDF URLs', () => {
    it.each([
        ['arxiv', 'https://arxiv.org/abs/1706.03762v7', 'https://arxiv.org/pdf/1706.03762v7'],
        ['arxiv', 'https://www.arxiv.org/abs/hep-th/9901001', 'https://arxiv.org/pdf/hep-th/9901001v2.pdf'],
        ['huggingface', hfPaper, hfPdf],
        ['acl', aclPaper, aclPdf],
        ['acl', 'https://aclanthology.org/N19-1423/', 'https://aclanthology.org/N19-1423.pdf'],
        ['cvf', cvfPaper, cvfPdf],
        ['cvf', `${legacyCvfFolder}/html/${legacyCvfSlug}.html`, `${legacyCvfFolder}/papers/${legacyCvfSlug}.pdf`],
        ['cvf', `${cvfWorkshopFolder}/html/${cvfWorkshopSlug}.html`, `${cvfWorkshopFolder}/papers/${cvfWorkshopSlug}.pdf`],
        ['neurips', neuripsPaper, neuripsPdf],
        ['neurips', `${legacyNeuripsFolder}/hash/${legacyNeuripsId}-Abstract.html`, `${legacyNeuripsFolder}/file/${legacyNeuripsId}-Paper.pdf`],
        ['neurips', `${legacyNeuripsFolder}/hash/${legacyNeuripsId}-Abstract.html`, `https://proceedings.neurips.cc/paper_files/paper/2017/file/${legacyNeuripsId}-Paper.pdf`],
    ])('recognizes %s and strips PDF tracking parameters and fragments', (site, page, pdf) => {
        expect(getPaperPdfSite(page)).toBe(site);
        expect(resolvePaperPdfUrl(page, `${pdf}?unused=1#page=2`)).toBe(pdf);
    });

    it.each([
        'not-a-url', 'http://huggingface.co/papers/2501.12948', 'https://user@aclanthology.org/N19-1423/',
        'https://:secret@huggingface.co/papers/2501.12948', 'https://huggingface.co:444/papers/2501.12948',
        'https://huggingface.co.evil.example/papers/2501.12948', 'https://huggingface.co/papers',
        'https://huggingface.co/papers/2026-01-01', 'https://arxiv.org/html/1706.03762', aclPdf,
        'https://openaccess.thecvf.com/CVPR2024', 'https://papers.nips.cc/paper_files/paper/2017',
    ])('rejects sources outside the adapted paper pages: %s', source => {
        expect(getPaperPdfSite(source)).toBeNull();
        expect(resolvePaperPdfUrl(source, hfPdf)).toBeNull();
    });

    it.each([
        [hfPaper, 'https://arxiv.org/pdf/2501.12949'],
        [hfPaper, 'https://arxiv.org/abs/2501.12948'],
        [hfPaper, 'https://example.org/pdf/2501.12948'],
        [hfPaper, 'http://arxiv.org/pdf/2501.12948'],
        [hfPaper, 'https://arxiv.org:444/pdf/2501.12948'],
        [hfPaper, '/pdf/2501.12948'],
        [aclPaper, aclPdf.replace('aclanthology.org', 'evil.example')],
        [aclPaper, aclPdf.replace('acl-long.1', 'acl-long.10')],
        [cvfPaper, cvfPdf.replace('openaccess.thecvf.com', 'evil.example')],
        [cvfPaper, cvfPdf.replace('/papers/', '/supplemental/')],
        [cvfPaper, cvfPdf.replace('ICCV2023', 'CVPR2023')],
        [cvfPaper, cvfPdf.replace(cvfSlug, `Other_${cvfSlug}`)],
        [cvfPaper.toUpperCase(), cvfPaper.toUpperCase()],
        [neuripsPaper, neuripsPdf.replace('proceedings.neurips.cc', 'evil.example')],
        [neuripsPaper, neuripsPdf.replace('/2024/', '/2023/')],
        [neuripsPaper, neuripsPdf.replace(neuripsTrack, 'Conference')],
        [neuripsPaper, neuripsPdf.replace('-Paper-', '-Supplemental-')],
        [neuripsPaper, neuripsPdf.replace(neuripsId, legacyNeuripsId)],
        ['https://arxiv.org/abs/1706.03762v7', 'https://arxiv.org/pdf/1706.03762v1'],
    ])('rejects an unrelated or non-PDF target %s → %s', (source, target) => {
        expect(resolvePaperPdfUrl(source, target)).toBeNull();
    });
});
